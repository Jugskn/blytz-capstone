from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import FileResponse, Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from apps.accounts.decorators import customer_required, staff_required
from apps.designs.garment_choices import format_garment_display
from apps.designs.models import ActivityLog
from apps.orders.customer_display import (
    ORDERS_PER_PAGE,
    customer_order_status_known,
    customer_order_status_label,
)
from apps.orders.design_details import parse_design_details
from apps.orders.forms import (
    ApproveFinalDesignForm,
    CompleteOrderForm,
    FinalDesignUploadForm,
    OrderPaymentUploadForm,
    OrderPricingForm,
    PaymentRejectForm,
)
from apps.orders.models import Order, OrderPhaseChange, Payment, PaymentChannel

STALE_FINAL_DESIGN_MESSAGE = (
    "The design was updated. Please review the new version."
)
UPLOAD_ONLY_PENDING_EDIT = (
    "Final design can only be uploaded while the order is in Pending Edit."
)
APPROVE_ONLY_PENDING_EDIT = (
    "Final design can only be approved while the order is in Pending Edit."
)

ORDER_STATUS_STEP = {
    Order.Status.JOB_REQUEST: 1,
    Order.Status.PENDING_EDIT: 2,
    Order.Status.PRODUCTION: 3,
    Order.Status.COMPLETED: 4,
}

JOB_STEPS = [
    {"label": "Job Request", "description": "Submitted"},
    {"label": "Pending Edit", "description": "Revisions"},
    {"label": "Production", "description": "In progress"},
    {"label": "Completed", "description": "Done"},
]

PIPELINE_COLUMNS = [
    (Order.Status.JOB_REQUEST, "Job Request"),
    (Order.Status.PENDING_EDIT, "Pending Edit"),
    (Order.Status.PRODUCTION, "Production"),
    (Order.Status.COMPLETED, "Completed"),
]

ADVANCE_NEEDS_ACCEPTED_PAYMENT = (
    "At least one accepted payment is required before moving to Pending Edit."
)
ADVANCE_NEEDS_DOWNPAYMENT = (
    'Payment status must be "Downpayment Paid" before moving this order forward.'
)
ADVANCE_NEEDS_FULL_PAYMENT = (
    'Payment status must be "Fully Paid" before this order can be completed. '
    "Request the final payment and wait until the customer's payment is accepted."
)

@customer_required
def order_list(request):
    """
    Customer submission history: one row per Order owned by the customer.

    Source of truth: Order (customer, created_at, status, preview_image) with
    design title/garment from Order.design. Drafts without an Order are omitted.
    """
    qs = (
        Order.objects.filter(customer=request.user)
        .select_related("design")
        .prefetch_related("payments")
        .order_by("-created_at")
    )
    page_obj = Paginator(qs, ORDERS_PER_PAGE).get_page(request.GET.get("page"))
    submissions = []
    for order in page_obj:
        design = order.design
        submissions.append(
            {
                "order": order,
                "title": design.title if design else "Untitled design",
                "submitted_at": order.created_at,
                "garment_label": format_garment_display(
                    design.garment_template if design else "",
                    design.garment_color if design else "",
                ),
                "status_label": customer_order_status_label(order.status),
                "status_known": customer_order_status_known(order.status),
                "preview": order.preview_image,
            }
        )
    return render(
        request,
        "orders/order_list.html",
        {
            "page_obj": page_obj,
            "submissions": submissions,
            # Keep legacy name for any template includes expecting "orders".
            "orders": page_obj,
        },
    )


@customer_required
@require_http_methods(["GET", "POST"])
def order_detail(request, order_id):
    order = get_object_or_404(
        Order.objects.select_related("design").prefetch_related("payments__channel"),
        order_id=order_id,
        customer=request.user,
    )
    channels = PaymentChannel.objects.filter(is_active=True)
    payment_form = OrderPaymentUploadForm()
    can_upload = order.can_accept_additional_payment()

    if request.method == "POST":
        if not can_upload:
            raise PermissionDenied
        payment_form = OrderPaymentUploadForm(request.POST, request.FILES)
        if payment_form.is_valid():
            try:
                with transaction.atomic():
                    locked = Order.objects.select_for_update().get(pk=order.pk)
                    if locked.pending_payment is not None:
                        messages.error(
                            request,
                            "A payment is already awaiting staff review.",
                        )
                        return redirect("order_detail", order_id=order.order_id)
                    if locked.payment_status == Order.FULLY_PAID:
                        messages.error(request, "This order is fully paid.")
                        return redirect("order_detail", order_id=order.order_id)
                    amount = payment_form.cleaned_data["amount_claimed"]
                    required = locked.amount_due
                    if required is not None and amount != required:
                        messages.error(
                            request,
                            f"Please pay the exact amount requested: ₱{required}.",
                        )
                        return redirect("order_detail", order_id=order.order_id)
                    Payment.objects.create(
                        order=locked,
                        channel=payment_form.cleaned_data["channel"],
                        amount_claimed=amount,
                        proof_file=payment_form.cleaned_data["proof_file"],
                        reference_number=payment_form.cleaned_data.get("reference_number", ""),
                        status=Payment.Status.PENDING,
                        purpose=(
                            Payment.Purpose.BALANCE
                            if locked.balance_due is not None
                            else Payment.Purpose.DOWNPAYMENT
                        ),
                    )
            except IntegrityError:
                messages.error(
                    request,
                    "A payment is already awaiting staff review.",
                )
                return redirect("order_detail", order_id=order.order_id)
            messages.success(
                request,
                "Payment proof submitted. Staff will review it shortly.",
            )
            return redirect("order_detail", order_id=order.order_id)

    # Refresh helpers after possible POST validation errors
    order = get_object_or_404(
        Order.objects.select_related("design").prefetch_related("payments__channel"),
        order_id=order_id,
        customer=request.user,
    )
    pending = order.pending_payment
    can_upload = order.can_accept_additional_payment()
    fully_paid = order.payment_status == Order.FULLY_PAID

    return render(
        request,
        "orders/order_detail.html",
        {
            "order": order,
            "job_steps": JOB_STEPS,
            "current_step": ORDER_STATUS_STEP.get(order.status, 1),
            "payments": order.payments.all(),
            "channels": channels,
            "payment_form": payment_form,
            "can_upload": can_upload,
            "pending_payment": pending,
            "fully_paid": fully_paid,
            "can_approve_final_design": order.can_approve_final_design(),
            "required_amount": order.amount_due,
            "rejected_payment": order.rejected_request,
        },
    )


@customer_required
@require_POST
def approve_final_design(request, order_id):
    order = get_object_or_404(Order, order_id=order_id)
    if order.customer_id != request.user.pk:
        raise PermissionDenied

    form = ApproveFinalDesignForm(request.POST)
    if not form.is_valid():
        messages.error(request, "Could not approve the final design.")
        return redirect("order_detail", order_id=order.order_id)

    seen_version = form.cleaned_data["version"]

    with transaction.atomic():
        locked = Order.objects.select_for_update().get(pk=order.pk)
        if locked.customer_id != request.user.pk:
            raise PermissionDenied
        if locked.status != Order.Status.PENDING_EDIT:
            messages.error(request, APPROVE_ONLY_PENDING_EDIT)
            return redirect("order_detail", order_id=locked.order_id)
        if not locked.final_design or locked.final_design_version < 1:
            messages.error(request, "No final design is available to approve.")
            return redirect("order_detail", order_id=locked.order_id)
        if seen_version != locked.final_design_version:
            messages.error(request, STALE_FINAL_DESIGN_MESSAGE)
            return redirect("order_detail", order_id=locked.order_id)
        if locked.approved_version == locked.final_design_version:
            messages.info(
                request,
                "You already approved this version. Staff will move your order to Production.",
            )
            return redirect("order_detail", order_id=locked.order_id)

        # Record the approval only. Staff decide when the order moves to Production.
        locked.approved_version = locked.final_design_version
        locked.approved_at = timezone.now()
        locked.save(update_fields=["approved_version", "approved_at"])
        ActivityLog.objects.create(
            customer=locked.customer,
            design=locked.design,
            order=locked,
            kind=ActivityLog.Kind.DESIGN_APPROVED,
        )

    messages.success(
        request,
        "Thank you! Your approval was sent to our staff. They will move your order to Production.",
    )
    return redirect("order_detail", order_id=locked.order_id)

@staff_required
def jobs_pipeline(request):
    qs = Order.objects.select_related("customer", "design").prefetch_related(
        "payments__reviewed_by"
    )
    q = (request.GET.get("q") or "").strip()
    customer = (request.GET.get("customer") or "").strip()
    pending_review = (request.GET.get("pending_review") or "").strip() in {
        "1",
        "true",
        "yes",
    }
    if q:
        qs = qs.filter(order_id__icontains=q)
    if customer:
        qs = qs.filter(
            Q(customer__email__icontains=customer)
            | Q(customer__first_name__icontains=customer)
            | Q(customer__last_name__icontains=customer)
        )
    if pending_review:
        qs = qs.filter(payments__status=Payment.Status.PENDING).distinct()

    columns = []
    for status, label in PIPELINE_COLUMNS:
        columns.append(
            {
                "status": status,
                "label": label,
                "orders": [o for o in qs if o.status == status],
            }
        )

    return render(
        request,
        "orders/jobs_pipeline.html",
        {
            "columns": columns,
            "q": q,
            "customer": customer,
            "pending_review": pending_review,
        },
    )


@staff_required
def staff_order_detail(request, order_id):
    order = get_object_or_404(
        Order.objects.select_related("customer", "design").prefetch_related(
            "payments__channel",
            "payments__reviewed_by",
            "phase_changes__changed_by",
        ),
        order_id=order_id,
    )
    next_status = order.next_status()
    advance_blocked_reason = None
    if (
        next_status in (Order.Status.PENDING_EDIT, Order.Status.PRODUCTION)
        and order.payment_status != Order.DOWNPAYMENT_PAID
    ):
        advance_blocked_reason = ADVANCE_NEEDS_DOWNPAYMENT
    elif (
        next_status == Order.Status.COMPLETED
        and order.payment_status != Order.FULLY_PAID
    ):
        advance_blocked_reason = ADVANCE_NEEDS_FULL_PAYMENT

    can_request_final_payment = (
        order.status == Order.Status.PRODUCTION
        and order.balance_paid == 0
        and order.pending_payment is None
    )

    design_details = parse_design_details(order.canvas_json_snapshot)
    is_pending_edit = order.status == Order.Status.PENDING_EDIT

    production_confirm_message = ""
    if is_pending_edit and next_status == Order.Status.PRODUCTION:
        if not order.final_design:
            production_confirm_message = (
                "No final design has been uploaded. Move to Production anyway?"
            )
        elif not order.customer_approved_current_design:
            production_confirm_message = (
                "The customer has not approved the latest final design yet. "
                "Move to Production anyway?"
            )

    return render(
        request,
        "orders/staff_order_detail.html",
        {
            "order": order,
            "payments": order.payments.all(),
            "phase_changes": order.phase_changes.all(),
            "design_details": design_details,
            "job_steps": JOB_STEPS,
            "current_step": ORDER_STATUS_STEP.get(order.status, 1),
            "next_status": next_status,
            "next_status_label": (
                dict(Order.Status.choices).get(next_status) if next_status else None
            ),
            "advance_label": (
                f"Move to {dict(Order.Status.choices).get(next_status)}"
                if next_status
                else None
            ),
            "advance_blocked_reason": advance_blocked_reason,
            "reject_form": PaymentRejectForm(),
            "can_edit_pricing": request.user.can_edit_accounting_page(),
            "can_request_final_payment": can_request_final_payment,            
            "final_design_form": FinalDesignUploadForm(),
            "is_pending_edit": is_pending_edit,
            "needs_final_design_confirm": (
                is_pending_edit
                and next_status == Order.Status.PRODUCTION
                and not order.final_design
            ),
            "production_confirm_message": production_confirm_message,
        },
    )


@staff_required
@require_POST
def upload_final_design(request, order_id):
    order = get_object_or_404(Order, order_id=order_id)
    form = FinalDesignUploadForm(request.POST, request.FILES)
    if not form.is_valid():
        for err in form.errors.get("final_design", form.non_field_errors()):
            messages.error(request, err)
        if not form.errors.get("final_design") and not form.non_field_errors():
            messages.error(request, "Could not upload the final design.")
        return redirect("staff_order_detail", order_id=order.order_id)

    uploaded = form.cleaned_data["final_design"]

    with transaction.atomic():
        locked = Order.objects.select_for_update().get(pk=order.pk)
        if locked.status != Order.Status.PENDING_EDIT:
            messages.error(request, UPLOAD_ONLY_PENDING_EDIT)
            return redirect("staff_order_detail", order_id=locked.order_id)

        if locked.final_design:
            locked.final_design.delete(save=False)

        locked.final_design = uploaded
        locked.final_design_version = locked.final_design_version + 1
        locked.final_design_uploaded_at = timezone.now()
        locked.save(
            update_fields=[
                "final_design",
                "final_design_version",
                "final_design_uploaded_at",
            ]
        )
        if locked.final_design_version > 1:
            ActivityLog.objects.create(
                customer=locked.customer,
                design=locked.design,
                order=locked,
                kind=ActivityLog.Kind.DESIGN_REVISED,
            )

    messages.success(
        request,
        f"Final design uploaded (version {locked.final_design_version}).",
    )
    return redirect("staff_order_detail", order_id=locked.order_id)


@staff_required
@require_GET
def download_order_preview(request, order_id, side):
    """Staff-only full-resolution mock-up PNG download (front or back)."""
    order = get_object_or_404(Order, order_id=order_id)
    side = (side or "").strip().lower()
    if side == "front":
        field = order.preview_image
        filename = f"{order.order_id}-front.png"
    elif side == "back":
        field = order.preview_back_image
        filename = f"{order.order_id}-back.png"
    else:
        raise Http404
    if not field:
        raise Http404
    try:
        return FileResponse(
            field.open("rb"),
            as_attachment=True,
            filename=filename,
            content_type="image/png",
        )
    except FileNotFoundError as exc:
        raise Http404 from exc


@staff_required
@require_POST
def advance_order_phase(request, order_id):
    order = get_object_or_404(
        Order.objects.prefetch_related("payments"),
        order_id=order_id,
    )
    nxt = order.next_status()
    if not nxt:
        messages.error(request, "Order is already completed.")
        return redirect("staff_order_detail", order_id=order.order_id)

    if (
        nxt in (Order.Status.PENDING_EDIT, Order.Status.PRODUCTION)
        and order.payment_status != Order.DOWNPAYMENT_PAID
    ):
        messages.error(request, ADVANCE_NEEDS_DOWNPAYMENT)
        return redirect("staff_order_detail", order_id=order.order_id)

    if nxt == Order.Status.COMPLETED and order.payment_status != Order.FULLY_PAID:
        messages.error(request, ADVANCE_NEEDS_FULL_PAYMENT)
        return redirect("staff_order_detail", order_id=order.order_id)

    previous = order.status
    order.status = nxt
    order.save(update_fields=["status"])
    OrderPhaseChange.objects.create(
        order=order,
        from_status=previous,
        to_status=nxt,
        changed_by=request.user,
    )
    ActivityLog.objects.create(
        customer=order.customer,
        design=order.design,
        order=order,
        kind=ActivityLog.Kind.PHASE_MOVED,
    )
    messages.success(
        request,
        f"Moved {order.order_id} from {previous} → {nxt}.",
    )
    return redirect("staff_order_detail", order_id=order.order_id)


@staff_required
@require_POST
def review_payment(request, order_id, payment_id):
    order = get_object_or_404(Order, order_id=order_id)
    payment = get_object_or_404(Payment, pk=payment_id, order=order)

    if payment.status != Payment.Status.PENDING:
        messages.error(request, "Only pending payments can be reviewed.")
        return redirect("staff_order_detail", order_id=order.order_id)

    action = (request.POST.get("action") or "").strip().lower()
    if action == "accept":
        payment.accept(request.user)
        messages.success(request, "Payment accepted.")
    elif action == "reject":
        form = PaymentRejectForm(request.POST)
        if form.is_valid():
            payment.reject(
                request.user,
                form.cleaned_data.get("rejection_reason") or "",
                form.cleaned_data.get("requested_amount"),
            )
            messages.success(request, "Payment rejected.")
        else:
            messages.error(request, "Could not reject payment.")
    else:
        raise PermissionDenied

    return redirect("staff_order_detail", order_id=order.order_id)

def _money(value):
    return "not set" if value is None else f"₱{value:,.2f}"

@staff_required
@require_POST
def update_order_pricing(request, order_id):
    order = get_object_or_404(Order, order_id=order_id)
    if not request.user.can_edit_accounting_page():
        raise PermissionDenied

    form = OrderPricingForm(request.POST)
    if not form.is_valid():
        for errors in form.errors.values():
            for err in errors:
                messages.error(request, err)
        return redirect("staff_order_detail", order_id=order.order_id)

    old_total, old_down = order.agreed_total, order.agreed_downpayment
    order.agreed_total = form.cleaned_data["agreed_total"]
    order.agreed_downpayment = form.cleaned_data["agreed_downpayment"]
    order.accounting_edited_by = request.user
    order.accounting_edited_at = timezone.now()
    order.save(
        update_fields=[
            "agreed_total",
            "agreed_downpayment",
            "accounting_edited_by",
            "accounting_edited_at",
        ]
    )
    if (old_total, old_down) != (order.agreed_total, order.agreed_downpayment):
        actor = request.user.get_full_name() or request.user.email
        ActivityLog.objects.create(
            customer=order.customer,
            design=order.design,
            order=order,
            kind=ActivityLog.Kind.PRICING_UPDATED,
            detail=(
                f"Total {_money(old_total)} → {_money(order.agreed_total)} · "
                f"Downpayment {_money(old_down)} → {_money(order.agreed_downpayment)} · by {actor}"
            ),
        )
    messages.success(request, "Order pricing updated.")    
    return redirect("staff_order_detail", order_id=order.order_id)

@staff_required
@require_POST
def request_final_payment(request, order_id):
    order = get_object_or_404(
        Order.objects.prefetch_related("payments"), order_id=order_id
    )
    back = redirect("staff_order_detail", order_id=order.order_id)

    if order.status != Order.Status.PRODUCTION:
        messages.error(
            request,
            "The final payment can only be requested while the order is in Production.",
        )
        return back
    if order.balance_paid > 0 or order.pending_payment is not None:
        messages.error(
            request,
            "The final balance can't be changed after the customer has paid or submitted a payment.",
        )
        return back

    form = CompleteOrderForm(request.POST)
    if not form.is_valid():
        messages.error(request, "Enter the final balance (0 or more).")
        return back

    order.balance_due = form.cleaned_data["balance_due"]
    order.save(update_fields=["balance_due"])
    actor = request.user.get_full_name() or request.user.email
    ActivityLog.objects.create(
        customer=order.customer,
        design=order.design,
        order=order,
        kind=ActivityLog.Kind.FINAL_PAYMENT_REQUESTED,
        detail=f"Final balance {_money(order.balance_due)} · by {actor}",
    )
    messages.success(
        request,
        f"Final payment requested: ₱{order.balance_due}. The customer can now pay it.",
    )
    return back