import json
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django import forms
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.orders.models import PaymentChannel

ALLOWED_PROOF_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf"}
ALLOWED_PROOF_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "application/pdf",
}
MAX_PROOF_BYTES = 5 * 1024 * 1024


def _parse_canvas_json(raw):
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise forms.ValidationError("Invalid canvas JSON.") from exc
    if not isinstance(data, dict):
        raise forms.ValidationError("Canvas JSON must be an object.")
    return data


class DesignSaveForm(forms.Form):
    canvas_json = forms.CharField(required=False)
    title = forms.CharField(max_length=200, required=False)

    def clean_canvas_json(self):
        return _parse_canvas_json(self.cleaned_data.get("canvas_json") or "{}")


class DesignSubmitForm(forms.Form):
    channel = forms.ModelChoiceField(
        queryset=PaymentChannel.objects.filter(is_active=True),
    )
    amount_claimed = forms.DecimalField(min_value=Decimal("0.01"), max_digits=10, decimal_places=2)
    proof_file = forms.FileField()
    canvas_json = forms.CharField(required=False)
    window_started_at = forms.CharField()

    def clean_canvas_json(self):
        return _parse_canvas_json(self.cleaned_data.get("canvas_json") or "{}")

    def clean_window_started_at(self):
        raw = self.cleaned_data["window_started_at"]
        started = parse_datetime(raw)
        if started is None:
            raise forms.ValidationError("Invalid payment window timestamp.")
        if timezone.is_naive(started):
            started = timezone.make_aware(started, timezone.get_current_timezone())
        # Reject absurd future starts
        if started > timezone.now() + timedelta(minutes=1):
            raise forms.ValidationError("Invalid payment window start.")
        return started

    def clean_proof_file(self):
        proof = self.cleaned_data["proof_file"]
        name = (proof.name or "").lower()
        ext = "." + name.rsplit(".", 1)[-1] if "." in name else ""
        if ext not in ALLOWED_PROOF_EXTENSIONS:
            raise forms.ValidationError(
                "Proof must be a PNG, JPG, JPEG, or PDF file."
            )
        if proof.size > MAX_PROOF_BYTES:
            raise forms.ValidationError("Proof file must be 5 MB or smaller.")
        content_type = getattr(proof, "content_type", "") or ""
        if content_type and content_type not in ALLOWED_PROOF_CONTENT_TYPES:
            # Some browsers send empty/octet-stream; extension check is primary
            if content_type not in {"application/octet-stream", ""}:
                raise forms.ValidationError(
                    "Proof must be a PNG, JPG, JPEG, or PDF file."
                )
        return proof

    def clean_amount_claimed(self):
        amount = self.cleaned_data["amount_claimed"]
        try:
            amount = Decimal(amount)
        except (InvalidOperation, TypeError) as exc:
            raise forms.ValidationError("Enter a valid amount.") from exc
        if amount <= 0:
            raise forms.ValidationError("Amount must be greater than zero.")
        return amount
