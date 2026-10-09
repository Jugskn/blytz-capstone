from decimal import Decimal

from django.conf import settings
from django.db import models, transaction
from django.db.models import Max, Sum
from django.urls import reverse


class PaymentChannel(models.Model):
    class Kind(models.TextChoices):
        GCASH = "gcash", "GCash"
        MAYA = "maya", "Maya"
        BANK = "bank", "Bank"

    kind = models.CharField(max_length=20, choices=Kind.choices)
    display_name = models.CharField(max_length=100)
    account_name = models.CharField(max_length=150)
    account_number = models.CharField(max_length=100)
    qr_image = models.ImageField(upload_to="payment_channels/", blank=True)
    instructions = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["kind", "display_name"]

    def __str__(self) -> str:
        return self.display_name


class Order(models.Model):
    class Status(models.TextChoices):
        JOB_REQUEST = "job_request", "Job Request"
        PENDING_EDIT = "pending_edit", "Pending Edit"
        PRODUCTION = "production", "Production"
        COMPLETED = "completed", "Completed"

    FULLY_PAID = "Fully Paid"
    OUTSTANDING = "Outstanding Balance"

    PHASE_FLOW = [
        Status.JOB_REQUEST,
        Status.PENDING_EDIT,
        Status.PRODUCTION,
        Status.COMPLETED,
    ]

    order_id = models.CharField(max_length=20, unique=True, blank=True, editable=False)
    customer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="orders",
    )
    design = models.ForeignKey(
        "designs.Design",
        on_delete=models.PROTECT,
        related_name="orders",
    )
    canvas_json_snapshot = models.JSONField(default=dict, blank=True)
    preview_image = models.ImageField(upload_to="order_previews/", blank=True)
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.JOB_REQUEST,
    )
    agreed_total = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Set by admin/accounting. Null until priced.",
    )
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    accounting_edited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="accounting_edits",
    )
    accounting_edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.order_id or f"Order#{self.pk}"

    def get_absolute_url(self):
        return reverse("order_detail", kwargs={"order_id": self.order_id})

    def next_status(self) -> str | None:
        try:
            idx = self.PHASE_FLOW.index(self.status)
        except ValueError:
            return None
        if idx >= len(self.PHASE_FLOW) - 1:
            return None
        return self.PHASE_FLOW[idx + 1]

    @classmethod
    def generate_order_id(cls) -> str:
        with transaction.atomic():
            latest = (
                cls.objects.select_for_update()
                .exclude(order_id="")
                .aggregate(max_id=Max("order_id"))
                .get("max_id")
            )
            if latest:
                try:
                    number = int(str(latest).rsplit("-", 1)[-1]) + 1
                except (TypeError, ValueError):
                    number = cls.objects.count() + 1
            else:
                number = 1
            return f"BLY-{number:06d}"

    def save(self, *args, **kwargs):
        if not self.order_id:
            self.order_id = self.generate_order_id()
        super().save(*args, **kwargs)

    @property
    def total_paid(self) -> Decimal:
        total = self.payments.aggregate(total=Sum("amount_claimed"))["total"]
        return total if total is not None else Decimal("0.00")

    @property
    def balance(self) -> Decimal | None:
        if self.agreed_total is None:
            return None
        return self.agreed_total - self.total_paid

    @property
    def payment_status(self) -> str:
        if self.agreed_total is None:
            return self.OUTSTANDING
        if self.balance is not None and self.balance <= 0:
            return self.FULLY_PAID
        return self.OUTSTANDING


class Payment(models.Model):
    order = models.ForeignKey(
        Order,
        on_delete=models.CASCADE,
        related_name="payments",
    )
    channel = models.ForeignKey(
        PaymentChannel,
        on_delete=models.PROTECT,
        related_name="payments",
        null=True,
        blank=True,
    )
    amount_claimed = models.DecimalField(max_digits=10, decimal_places=2)
    proof_file = models.FileField(upload_to="payment_proofs/", blank=True)
    is_manual_adjustment = models.BooleanField(default=False)
    note = models.CharField(max_length=255, blank=True)
    recorded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="recorded_payments",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.order.order_id} · {self.amount_claimed}"
