import json
from datetime import timedelta

from django.conf import settings
from django.contrib import messages
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from apps.accounts.decorators import customer_required
from apps.orders.models import Order, Payment, PaymentChannel
from apps.sales.models import Lead

from .forms import DesignSaveForm, DesignSubmitForm
from .models import ActivityLog, Design


def _wants_json(request) -> bool:
    accept = request.headers.get("Accept", "")
    return (
        "application/json" in accept
        or request.headers.get("X-Requested-With") == "XMLHttpRequest"
    )


@customer_required
def dashboard(request):
    designs = Design.objects.filter(owner=request.user).order_by("-updated_at")
    orders = Order.objects.filter(customer=request.user).select_related("design")

    designs_list = list(designs)
    submitted_ids = set(
        Order.objects.filter(design_id__in=[d.pk for d in designs_list]).values_list(
            "design_id", flat=True
        )
    )
    submitted_count = len(submitted_ids)
    draft_count = len(designs_list) - submitted_count

    return render(
        request,
        "designs/dashboard.html",
        {
            "designs": designs_list[:5],
            "orders": orders[:5],
            "stat_designs": len(designs_list),
            "stat_drafts": draft_count,
            "stat_submitted": submitted_count,
            "stat_orders": orders.count(),
            "submitted_ids": submitted_ids,
        },
    )


@customer_required
def design_list(request):
    designs = Design.objects.filter(owner=request.user).prefetch_related("orders")
    return render(request, "designs/design_list.html", {"designs": designs})


@customer_required
def design_detail(request, pk):
    design = get_object_or_404(Design, pk=pk, owner=request.user)
    return redirect("design_editor", pk=design.pk)


@customer_required
def design_create(request):
    if request.method != "POST":
        return redirect("design_list")

    design = Design.objects.create(
        owner=request.user,
        title="Untitled design",
        garment_template="tee",
        garment_color="black",
        canvas_json={"version": 1, "objects": []},
    )
    ActivityLog.objects.create(
        customer=request.user,
        design=design,
        kind=ActivityLog.Kind.DESIGN_CREATED,
    )
    messages.success(request, "Draft design created.")
    return redirect("design_editor", pk=design.pk)


@customer_required
def design_editor(request, pk):
    design = get_object_or_404(Design, pk=pk, owner=request.user)
    channels = PaymentChannel.objects.filter(is_active=True)
    return render(
        request,
        "designs/editor.html",
        {
            "design": design,
            "channels": channels,
            "payment_window_minutes": settings.PAYMENT_WINDOW_MINUTES,
            "already_submitted": design.is_submitted,
            "canvas_json_initial": json.dumps(design.canvas_json or {}),
        },
    )


@customer_required
@require_POST
def design_save(request, pk):
    design = get_object_or_404(Design, pk=pk, owner=request.user)
    form = DesignSaveForm(request.POST, stored_canvas=design.canvas_json)
    if not form.is_valid():
        if _wants_json(request):
            return JsonResponse({"ok": False, "errors": form.errors}, status=400)
        messages.error(request, "Could not save design.")
        return redirect("design_editor", pk=pk)

    design.canvas_json = form.cleaned_data["canvas_json"]
    if form.cleaned_data.get("title"):
        design.title = form.cleaned_data["title"]
    if form.cleaned_data.get("garment_template") is not None:
        design.garment_template = form.cleaned_data["garment_template"]
    if form.cleaned_data.get("garment_color") is not None:
        design.garment_color = form.cleaned_data["garment_color"]
    design.save()

    if _wants_json(request):
        return JsonResponse({"ok": True, "updated_at": design.updated_at.isoformat()})
    messages.success(request, "Design saved.")
    return redirect("design_editor", pk=pk)


@customer_required
@require_POST
def design_submit(request, pk):
    design = get_object_or_404(Design, pk=pk, owner=request.user)

    if design.is_submitted:
        messages.error(request, "This design was already submitted.")
        return redirect("design_editor", pk=pk)

    form = DesignSubmitForm(
        request.POST, request.FILES, stored_canvas=design.canvas_json
    )
    if not form.is_valid():
        if _wants_json(request):
            return JsonResponse({"ok": False, "errors": form.errors}, status=400)
        for err in form.errors.values():
            messages.error(request, err.as_text())
        return redirect("design_editor", pk=pk)

    started = form.cleaned_data["window_started_at"]
    deadline = started + timedelta(minutes=settings.PAYMENT_WINDOW_MINUTES)
    if timezone.now() > deadline:
        if _wants_json(request):
            return JsonResponse(
                {"ok": False, "errors": {"window": ["Payment window expired."]}},
                status=400,
            )
        messages.error(request, "Payment window expired. Nothing was recorded.")
        return redirect("design_editor", pk=pk)

    channel = form.cleaned_data["channel"]
    amount = form.cleaned_data["amount_claimed"]
    proof = form.cleaned_data["proof_file"]
    canvas = form.cleaned_data["canvas_json"]

    try:
        with transaction.atomic():
            design.canvas_json = canvas
            update_fields = ["canvas_json", "updated_at"]
            if form.cleaned_data.get("garment_template") is not None:
                design.garment_template = form.cleaned_data["garment_template"]
                update_fields.append("garment_template")
            if form.cleaned_data.get("garment_color") is not None:
                design.garment_color = form.cleaned_data["garment_color"]
                update_fields.append("garment_color")
            design.save(update_fields=update_fields)

            # Staff read garment on order.design; both views live in
            # order.canvas_json_snapshot (and design.canvas_json) under B1.
            order = Order.objects.create(
                customer=request.user,
                design=design,
                canvas_json_snapshot=canvas,
                status=Order.Status.JOB_REQUEST,
                notes="Submitted from editor with payment claim.",
            )
            Payment.objects.create(
                order=order,
                channel=channel,
                amount_claimed=amount,
                proof_file=proof,
            )
            Lead.objects.create(
                customer=request.user,
                order=order,
                stage=Lead.Stage.NEW_LEAD,
            )
            ActivityLog.objects.create(
                customer=request.user,
                design=design,
                order=order,
                kind=ActivityLog.Kind.DESIGN_SUBMITTED,
            )
            ActivityLog.objects.create(
                customer=request.user,
                design=design,
                order=order,
                kind=ActivityLog.Kind.ORDER_CONFIRMED,
            )
    except ValidationError as exc:
        messages.error(request, str(exc))
        return redirect("design_editor", pk=pk)

    messages.success(request, f"Order {order.order_id} created.")
    if _wants_json(request):
        return JsonResponse({"ok": True, "redirect": order.get_absolute_url()})
    return redirect("order_detail", order_id=order.order_id)
