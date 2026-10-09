from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render

from apps.designs.models import Design
from apps.orders.models import Order
from apps.sales.models import Lead

from .decorators import admin_required, staff_required
from .forms import ProfileForm


@staff_required
def staff_home(request):
    orders = Order.objects.all()
    incomplete = Design.objects.prefetch_related("orders")
    incomplete_count = sum(1 for d in incomplete if not d.is_submitted)
    return render(
        request,
        "accounts/staff_home.html",
        {
            "stat_orders": orders.count(),
            "stat_job_requests": orders.filter(status=Order.Status.JOB_REQUEST).count(),
            "stat_leads": Lead.objects.count(),
            "stat_incomplete": incomplete_count,
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
