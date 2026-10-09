from django.contrib import messages
from django.db.models import Q
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_POST

from apps.accounts.decorators import customer_required, staff_required
from apps.designs.models import ActivityLog

from .models import Order

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


@customer_required
def order_list(request):
    orders = (
        Order.objects.filter(customer=request.user)
        .select_related("design")
        .prefetch_related("payments")
    )
    return render(request, "orders/order_list.html", {"orders": orders})


@customer_required
def order_detail(request, order_id):
    order = get_object_or_404(
        Order.objects.select_related("design").prefetch_related("payments__channel"),
        order_id=order_id,
        customer=request.user,
    )
    return render(
        request,
        "orders/order_detail.html",
        {
            "order": order,
            "job_steps": JOB_STEPS,
            "current_step": ORDER_STATUS_STEP.get(order.status, 1),
            "payments": order.payments.all(),
        },
    )


@staff_required
def jobs_pipeline(request):
    qs = Order.objects.select_related("customer", "design").prefetch_related("payments")

    q = (request.GET.get("q") or "").strip()
    customer = (request.GET.get("customer") or "").strip()
    if q:
        qs = qs.filter(order_id__icontains=q)
    if customer:
        qs = qs.filter(
            Q(customer__email__icontains=customer)
            | Q(customer__first_name__icontains=customer)
            | Q(customer__last_name__icontains=customer)
        )

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
        },
    )


@staff_required
def staff_order_detail(request, order_id):
    order = get_object_or_404(
        Order.objects.select_related("customer", "design").prefetch_related(
            "payments__channel"
        ),
        order_id=order_id,
    )
    return render(
        request,
        "orders/staff_order_detail.html",
        {
            "order": order,
            "payments": order.payments.all(),
            "job_steps": JOB_STEPS,
            "current_step": ORDER_STATUS_STEP.get(order.status, 1),
            "next_status": order.next_status(),
            "next_status_label": (
                dict(Order.Status.choices).get(order.next_status())
                if order.next_status()
                else None
            ),
            "advance_label": (
                f"Move to {dict(Order.Status.choices).get(order.next_status())}"
                if order.next_status()
                else None
            ),
        },
    )


@staff_required
@require_POST
def advance_order_phase(request, order_id):
    order = get_object_or_404(Order, order_id=order_id)
    nxt = order.next_status()
    if not nxt:
        messages.error(request, "Order is already completed.")
        return redirect("staff_order_detail", order_id=order.order_id)

    # Only one phase forward — ignore any client-supplied target
    previous = order.status
    order.status = nxt
    order.save(update_fields=["status"])
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
