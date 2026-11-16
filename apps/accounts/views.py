from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render

from apps.accounts.dashboard import PHASE_LABELS
from apps.designs.models import Design
from apps.orders.models import Order
from apps.sales.models import Lead

from .decorators import admin_required, staff_required
from .forms import ProfileForm


@staff_required
def staff_home(request):
    from decimal import Decimal

    from django.db.models import Count, Sum
    from django.utils import timezone

    from apps.orders.models import Payment

    # ---- Needs attention (work queue) ----
    pending_qs = Payment.objects.filter(status=Payment.Status.PENDING)
    payments_to_review = list(
        pending_qs.select_related("order", "order__customer", "channel").order_by(
            "created_at"
        )[:5]
    )
    payments_to_review_count = pending_qs.count()

    job_requests = Order.objects.filter(
        status=Order.Status.JOB_REQUEST
    ).prefetch_related("payments")
    ready_to_move_count = sum(
        1 for o in job_requests if o.payment_status == Order.DOWNPAYMENT_PAID
    )

    completed_with_balance = (
        Order.objects.filter(status=Order.Status.COMPLETED, balance_due__isnull=False)
        .select_related("customer", "design")
        .prefetch_related("payments")
    )
    balance_orders = [
        o for o in completed_with_balance if o.payment_status != Order.FULLY_PAID
    ]
    balance_outstanding_count = len(balance_orders)
    balance_outstanding_total = sum(
        (o.balance_remaining for o in balance_orders), Decimal("0.00")
    )
    attention_total = (
        payments_to_review_count + ready_to_move_count + balance_outstanding_count
    )

    # ---- Pipeline at a glance ----
    counts = {
        row["status"]: row["c"]
        for row in Order.objects.values("status").annotate(c=Count("id"))
    }
    total_orders = sum(counts.values())
    phase_rows = [
        {
            "status": status,
            "label": label,
            "count": counts.get(status, 0),
            "pct": round(counts.get(status, 0) * 100 / total_orders) if total_orders else 0,
        }
        for status, label in PHASE_LABELS
    ]

    # ---- This month ----
    month_start = timezone.now().replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    sales_total = Payment.objects.filter(
        status=Payment.Status.ACCEPTED, created_at__gte=month_start
    ).aggregate(total=Sum("amount_claimed"))["total"] or Decimal("0.00")

    # ---- Recent ----
    recent_orders = (
        Order.objects.select_related("customer", "design")
        .prefetch_related("payments")
        .order_by("-created_at")[:5]
    )
    recent_leads = Lead.objects.select_related("customer", "order__design").order_by(
        "-created_at"
    )[:3]

    return render(
        request,
        "accounts/staff_home.html",
        {
            "payments_to_review": payments_to_review,
            "payments_to_review_count": payments_to_review_count,
            "ready_to_move_count": ready_to_move_count,
            "balance_outstanding_count": balance_outstanding_count,
            "balance_outstanding_total": balance_outstanding_total,
            "attention_total": attention_total,
            "phase_rows": phase_rows,
            "total_orders": total_orders,
            "in_production_count": counts.get(Order.Status.PRODUCTION, 0),
            "completed_count": counts.get(Order.Status.COMPLETED, 0),
            "sales_total": sales_total,
            "recent_orders": recent_orders,
            "recent_leads": recent_leads,
        },
    )
@admin_required
def staff_admin_only(request):
    return render(request, "accounts/staff_admin_only.html")


@login_required
def profile(request):
    if not getattr(request.user, "is_customer", False) and not getattr(
        request.user, "is_staff_role", False
    ):
        return redirect("home")

    if request.method == "POST":
        form = ProfileForm(request.POST, instance=request.user)
        if form.is_valid():
            form.save()
            messages.success(request, "Profile updated.")
            return redirect("account_profile")
    else:
        form = ProfileForm(instance=request.user)

    base = (
        "base_staff.html"
        if getattr(request.user, "is_staff_role", False)
        else "base_customer.html"
    )
    return render(
        request,
        "accounts/profile.html",
        {"form": form, "base_template": base},
    )
