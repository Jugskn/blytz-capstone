from decimal import Decimal

from django.conf import settings
from django.db import models, transaction
from django.db.models import Max, Q, Sum
from django.urls import reverse
from django.utils import timezone


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

    OUTSTANDING = "Outstanding"
    DOWNPAYMENT_PAID = "Downpayment Paid"
    FULLY_PAID = "Fully Paid"

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
    preview_back_image = models.ImageField(upload_to="order_previews/", blank=True)
    final_design = models.FileField(upload_to="final_designs/", blank=True)
    final_design_version = models.PositiveIntegerField(default=0)
    final_design_uploaded_at = models.DateTimeField(null=True, blank=True)
    approved_version = models.PositiveIntegerField(null=True, blank=True)
    approved_at = models.DateTimeField(null=True, blank=True)
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
    agreed_downpayment = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Downpayment agreed with the customer outside the site (documentation).",
    )
    balance_due = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        help_text="Remaining balance entered by staff when the job is completed.",
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
        constraints = [
            # One customer submission per design. Revisions stay on this order.
            models.UniqueConstraint(
                fields=["design"],
                name="unique_order_per_design",
            ),
        ]

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

    def _payments_cached(self):
        cache = getattr(self, "_prefetched_objects_cache", None)
        if cache is not None and "payments" in cache:
            return list(self.payments.all())
        return None

    @property
    def total_paid(self) -> Decimal:
        cached = self._payments_cached()
        if cached is not None:
            return sum(
                (
                    p.amount_claimed
                    for p in cached
                    if p.status == Payment.Status.ACCEPTED
                ),
                Decimal("0.00"),
            )
        total = self.payments.filter(status=Payment.Status.ACCEPTED).aggregate(
            total=Sum("amount_claimed")
        )["total"]
        return total if total is not None else Decimal("0.00")

    @property
    def balance(self) -> Decimal | None:
        if self.agreed_total is None:
            return None
        return self.agreed_total - self.total_paid

    @property
    def balance_paid(self) -> Decimal:
        return sum(
            (
                p.amount_claimed
                for p in self.payments.all()
                if p.status == Payment.Status.ACCEPTED
                and p.purpose == Payment.Purpose.BALANCE
            ),
            Decimal("0.00"),
        )

    @property
    def balance_remaining(self) -> Decimal | None:
        if self.balance_due is None:
            return None
        return max(self.balance_due - self.balance_paid, Decimal("0.00"))

    @property
    def outstanding_amount(self) -> Decimal | None:
        """Amount still to collect: staff-entered final balance if set, else agreed total minus paid."""
        if self.balance_due is not None:
            return self.balance_remaining
        return self.balance
    @property
    def agreed_balance(self) -> Decimal | None:
        """Agreed total minus agreed downpayment (documentation only)."""
        if self.agreed_total is None or self.agreed_downpayment is None:
            return None
        return self.agreed_total - self.agreed_downpayment
    @property
    def downpayment_paid(self) -> Decimal:
        """Accepted money that was NOT a final-balance payment."""
        return self.total_paid - self.balance_paid

    @property
    def payment_tooltip(self) -> str:
        """Short multi-line breakdown shown when hovering the payment status."""
        lines = [f"Paid: ₱{self.total_paid:,.2f}"]
        if self.agreed_total is not None:
            lines.append(f"Agreed total: ₱{self.agreed_total:,.2f}")
        if self.balance_due is not None:
            lines.append(
                f"Final balance: ₱{self.balance_due:,.2f} "
                f"(₱{self.balance_remaining:,.2f} left)"
            )
        pending = self.pending_payment
        if pending is not None:
            lines.append(f"Awaiting review: ₱{pending.amount_claimed:,.2f}")
        rejected = self.rejected_request
        if rejected is not None:
            lines.append(f"Rejected: pay exactly ₱{rejected.requested_amount:,.2f}")
        return "\n".join(lines)
    @property
    def payment_status(self) -> str:
        if self.balance_due is not None:
            if self.balance_remaining <= 0:
                return self.FULLY_PAID
            return self.OUTSTANDING
        if self.has_accepted_payment:
            return self.DOWNPAYMENT_PAID
        return self.OUTSTANDING

    @property
    def rejected_request(self):
        """Latest payment, if staff rejected it and asked for an exact amount."""
        payments = sorted(
            self.payments.all(), key=lambda p: (p.created_at, p.pk), reverse=True
        )
        if payments:
            latest = payments[0]
            if latest.status == Payment.Status.REJECTED and latest.requested_amount:
                return latest
        return None

    @property
    def amount_due(self) -> Decimal | None:
        """Exact amount the customer must pay now, or None."""
        rejected = self.rejected_request
        if rejected is not None:
            return rejected.requested_amount
        if self.pending_payment is not None:
            return None
        remaining = self.balance_remaining
        if remaining is not None and remaining > 0:
            return remaining
        return None

    @property
    def has_accepted_payment(self) -> bool:
        cached = self._payments_cached()
        if cached is not None:
            return any(p.status == Payment.Status.ACCEPTED for p in cached)
        return self.payments.filter(status=Payment.Status.ACCEPTED).exists()

    @property
    def pending_payment(self):
        cached = self._payments_cached()
        if cached is not None:
            for payment in cached:
                if payment.status == Payment.Status.PENDING:
                    return payment
            return None
        return self.payments.filter(status=Payment.Status.PENDING).first()

    @property
    def latest_payment(self):
        """Most recent payment of any status (shows the latest review outcome)."""
        payments = sorted(
            self.payments.all(), key=lambda p: (p.created_at, p.pk), reverse=True
        )
        return payments[0] if payments else None

    def can_accept_additional_payment(self) -> bool:
        """True when a customer may upload another payment proof."""
        if self.pending_payment is not None:
            return False
        if self.payment_status == self.FULLY_PAID:
            return False
        if self.amount_due is not None:
            return True
        return not self.has_accepted_payment

    @property
    def final_design_is_pdf(self) -> bool:
        name = (getattr(self.final_design, "name", "") or "").lower()
        return name.endswith(".pdf")

    @property
    def final_design_is_image(self) -> bool:
        name = (getattr(self.final_design, "name", "") or "").lower()
        return name.endswith((".png", ".jpg", ".jpeg"))

    @property
    def customer_approved_current_design(self) -> bool:
        """True when the customer approved the latest uploaded final design version."""
        return (
            self.final_design_version > 0
            and self.approved_version == self.final_design_version
        )

    def can_approve_final_design(self) -> bool:
        """True when the owning customer may approve the current final design."""
        return (
            self.status == self.Status.PENDING_EDIT
            and bool(self.final_design)
            and self.final_design_version > 0
            and not self.customer_approved_current_design
        )


class Payment(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REJECTED = "rejected", "Rejected"

    class Purpose(models.TextChoices):
        DOWNPAYMENT = "downpayment", "Downpayment"
        BALANCE = "balance", "Balance"

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
    reference_number = models.CharField(max_length=100, blank=True)
    is_manual_adjustment = models.BooleanField(default=False)
    note = models.CharField(max_length=255, blank=True)
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    rejection_reason = models.CharField(max_length=255, blank=True)
    purpose = models.CharField(
        max_length=20,
        choices=Purpose.choices,
        default=Purpose.DOWNPAYMENT,
    )
    requested_amount = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reviewed_payments",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
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
        constraints = [
            models.UniqueConstraint(
                fields=["order"],
                condition=Q(status="pending"),
                name="unique_pending_payment_per_order",
            )
        ]

    def __str__(self) -> str:
        return f"{self.order.order_id} · {self.amount_claimed}"

    @property
    def is_pending(self) -> bool:
        return self.status == self.Status.PENDING

    @property
    def is_reviewed(self) -> bool:
        return self.status in {self.Status.ACCEPTED, self.Status.REJECTED}

    def accept(self, reviewer) -> None:
        if self.status != self.Status.PENDING:
            raise ValueError("Only pending payments can be reviewed.")
        self.status = self.Status.ACCEPTED
        self.reviewed_by = reviewer
        self.reviewed_at = timezone.now()
        self.rejection_reason = ""
        self.save(
            update_fields=[
                "status",
                "reviewed_by",
                "reviewed_at",
                "rejection_reason",
            ]
        )

    def reject(self, reviewer, reason: str = "", requested_amount=None) -> None:
        if self.status != self.Status.PENDING:
            raise ValueError("Only pending payments can be reviewed.")
        self.status = self.Status.REJECTED
        self.reviewed_by = reviewer
        self.reviewed_at = timezone.now()
        self.rejection_reason = (reason or "").strip()[:255]
        self.requested_amount = requested_amount
        self.save(
            update_fields=[
                "status",
                "reviewed_by",
                "reviewed_at",
                "rejection_reason",
                "requested_amount",
            ]
        )


class OrderPhaseChange(models.Model):
    """Audit row for every staff phase advance on an order."""

    order = models.ForeignKey(
        Order,
        on_delete=models.CASCADE,
        related_name="phase_changes",
    )
    from_status = models.CharField(max_length=20, choices=Order.Status.choices)
    to_status = models.CharField(max_length=20, choices=Order.Status.choices)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="order_phase_changes",
    )
    changed_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-changed_at"]

    def __str__(self) -> str:
        return f"{self.order}: {self.from_status} → {self.to_status}"
