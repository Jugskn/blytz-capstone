from decimal import Decimal

from django import forms
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from apps.accounts.decorators import staff_required
from apps.orders.models import Order, Payment, PaymentChannel


class AgreedTotalForm(forms.Form):
    agreed_total = forms.DecimalField(
        max_digits=10,
        decimal_places=2,
        min_value=Decimal("0.00"),
        required=True,
    )


class ManualPaymentForm(forms.Form):
    amount_claimed = forms.DecimalField(
        max_digits=10,
        decimal_places=2,
    )
    note = forms.CharField(max_length=255, required=False)
    channel = forms.ModelChoiceField(
        queryset=PaymentChannel.objects.filter(is_active=True),
        required=False,
    )
    proof_file = forms.FileField(required=False)

    def clean_amount_claimed(self):
        amount = self.cleaned_data["amount_claimed"]
        if amount == 0:
            raise forms.ValidationError("Amount cannot be zero.")
        return amount


@staff_required
def accounting_list(request):
    orders = list(
        Order.objects.select_related("customer", "design").prefetch_related("payments")
    )
    total_collected = sum((o.total_paid for o in orders), Decimal("0.00"))
    total_outstanding = sum(
        (o.balance for o in orders if o.balance is not None and o.balance > 0),
        Decimal("0.00"),
    )
    return render(
        request,
        "accounting/list.html",
        {
            "orders": orders,
            "total_collected": total_collected,
            "total_outstanding": total_outstanding,
            "can_edit": request.user.can_edit_accounting_page(),
        },
    )


@staff_required
@require_http_methods(["GET", "POST"])
def accounting_detail(request, order_id):
    order = get_object_or_404(
        Order.objects.select_related(
            "customer", "design", "accounting_edited_by"
        ).prefetch_related("payments__channel", "payments__recorded_by"),
        order_id=order_id,
    )
    can_edit = request.user.can_edit_accounting_page()
    total_form = AgreedTotalForm(initial={"agreed_total": order.agreed_total})
    payment_form = ManualPaymentForm()

    if request.method == "POST":
        if not can_edit:
            raise PermissionDenied

        action = request.POST.get("action")
        if action == "set_total":
            total_form = AgreedTotalForm(request.POST)
            if total_form.is_valid():
                order.agreed_total = total_form.cleaned_data["agreed_total"]
                order.accounting_edited_by = request.user
                order.accounting_edited_at = timezone.now()
                order.save(
                    update_fields=[
                        "agreed_total",
                        "accounting_edited_by",
                        "accounting_edited_at",
                    ]
                )
                messages.success(request, "Agreed total updated.")
                return redirect("accounting_detail", order_id=order.order_id)
        elif action == "add_payment":
            payment_form = ManualPaymentForm(request.POST, request.FILES)
            if payment_form.is_valid():
                Payment.objects.create(
                    order=order,
                    channel=payment_form.cleaned_data.get("channel"),
                    amount_claimed=payment_form.cleaned_data["amount_claimed"],
                    proof_file=payment_form.cleaned_data.get("proof_file"),
                    is_manual_adjustment=True,
                    note=payment_form.cleaned_data.get("note") or "Manual adjustment",
                    recorded_by=request.user,
                )
                order.accounting_edited_by = request.user
                order.accounting_edited_at = timezone.now()
                order.save(
                    update_fields=["accounting_edited_by", "accounting_edited_at"]
                )
                messages.success(request, "Manual payment recorded.")
                return redirect("accounting_detail", order_id=order.order_id)
        else:
            raise PermissionDenied

    return render(
        request,
        "accounting/detail.html",
        {
            "order": order,
            "payments": order.payments.all(),
            "can_edit": can_edit,
            "total_form": total_form,
            "payment_form": payment_form,
        },
    )
