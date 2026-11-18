from decimal import Decimal, InvalidOperation

from django import forms

from apps.orders.models import PaymentChannel
from apps.orders.proof import validate_and_process_proof, validate_final_design_file


class OrderPaymentUploadForm(forms.Form):
    channel = forms.ModelChoiceField(
        queryset=PaymentChannel.objects.filter(is_active=True),
    )
    amount_claimed = forms.DecimalField(
        min_value=Decimal("0.01"),
        max_digits=10,
        decimal_places=2,
    )
    
    proof_file = forms.FileField()
    reference_number = forms.CharField(max_length=100, required=False)

    def clean_proof_file(self):
        return validate_and_process_proof(self.cleaned_data["proof_file"])

    def clean_amount_claimed(self):
        amount = self.cleaned_data["amount_claimed"]
        try:
            amount = Decimal(amount)
        except (InvalidOperation, TypeError) as exc:
            raise forms.ValidationError("Enter a valid amount.") from exc
        if amount <= 0:
            raise forms.ValidationError("Amount must be greater than zero.")
        return amount


class PaymentRejectForm(forms.Form):
    rejection_reason = forms.CharField(
        max_length=255,
        required=False,
        strip=True,
    )
    requested_amount = forms.DecimalField(
        required=False,
        min_value=Decimal("0.01"),
        max_digits=10,
        decimal_places=2,
    )


class CompleteOrderForm(forms.Form):
    balance_due = forms.DecimalField(
        min_value=Decimal("0.00"),
        max_digits=10,
        decimal_places=2,
    )


class FinalDesignUploadForm(forms.Form):
    final_design = forms.FileField()

    def clean_final_design(self):
        return validate_final_design_file(self.cleaned_data["final_design"])


class ApproveFinalDesignForm(forms.Form):
    version = forms.IntegerField(min_value=1)

class OrderPricingForm(forms.Form):
    agreed_total = forms.DecimalField(
        required=False,
        min_value=Decimal("0.00"),
        max_digits=10,
        decimal_places=2,
    )
    agreed_downpayment = forms.DecimalField(
        required=False,
        min_value=Decimal("0.00"),
        max_digits=10,
        decimal_places=2,
    )

    def clean(self):
        data = super().clean()
        total = data.get("agreed_total")
        down = data.get("agreed_downpayment")
        if total is not None and down is not None and down > total:
            self.add_error(
                "agreed_downpayment",
                "The downpayment cannot be higher than the agreed total.",
            )
        return data
