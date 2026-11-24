from datetime import timedelta
from io import BytesIO
from decimal import Decimal

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone
from PIL import Image, ImageDraw, ImageFont

from apps.accounts.models import User
from apps.designs.models import ActivityLog, Design
from apps.orders.models import Order, OrderPhaseChange, Payment, PaymentChannel
from apps.sales.models import Lead


DEMO_PASSWORD = "demo-pass-123"


def placeholder_qr(label: str) -> ContentFile:
    img = Image.new("RGB", (240, 240), color=(11, 11, 12))
    # Simple light square as a stand-in QR block
    for x in range(40, 200):
        for y in range(40, 200):
            if (x // 20 + y // 20) % 2 == 0:
                img.putpixel((x, y), (201, 162, 39))
            else:
                img.putpixel((x, y), (246, 246, 245))
    buffer = BytesIO()
    img.save(buffer, format="PNG")
    return ContentFile(buffer.getvalue(), name=f"{label}-qr.png")


def placeholder_preview(label: str, color=(180, 180, 190)) -> ContentFile:
    img = Image.new("RGB", (400, 400), color=color)
    buffer = BytesIO()
    img.save(buffer, format="PNG")
    return ContentFile(buffer.getvalue(), name=f"{label}.png")


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # older Pillow: fixed-size built-in font
        return ImageFont.load_default()


def placeholder_proof(label: str, *, channel: str, amount, reference: str) -> ContentFile:
    """A fake payment receipt (PNG) to use as proof of payment in demo data."""
    img = Image.new("RGB", (480, 640), color=(250, 250, 248))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, 480, 96], fill=(11, 11, 12))
    draw.text((24, 36), f"{channel}  |  PAYMENT RECEIPT", font=_font(22), fill=(212, 175, 55))
    draw.text((24, 140), "Amount sent", font=_font(18), fill=(110, 110, 110))
    draw.text((24, 168), f"PHP {amount}", font=_font(34), fill=(20, 20, 20))
    draw.text((24, 240), "Reference no.", font=_font(18), fill=(110, 110, 110))
    draw.text((24, 268), reference, font=_font(28), fill=(20, 20, 20))
    draw.text((24, 340), "Sent successfully", font=_font(22), fill=(30, 140, 60))
    draw.text((24, 596), "Sample image - demo data only", font=_font(16), fill=(150, 150, 150))
    buffer = BytesIO()
    img.save(buffer, format="PNG")
    return ContentFile(buffer.getvalue(), name=f"{label}-proof.png")


# --- Payment workflow constants (mirror the live flow) -----------------------
PENDING = Payment.Status.PENDING
ACCEPTED = Payment.Status.ACCEPTED
REJECTED = Payment.Status.REJECTED
DOWN = Payment.Purpose.DOWNPAYMENT
BAL = Payment.Purpose.BALANCE


def pay(amount, status, purpose=DOWN, hours=3, requested=None, reason=""):
    """One payment claim. `hours` = how long after the order was created."""
    return {
        "amount": amount,
        "status": status,
        "purpose": purpose,
        "hours": hours,
        "requested": requested,
        "reason": reason,
    }


# One scenario per demo order. Rules the data follows:
#   * Pending Edit / Production always have an ACCEPTED downpayment.
#   * Completed orders carry the staff-entered balance_due.
#   * Payment status is never stored; it is derived from these payments.
SCENARIOS = [
    # 1. Job Request: downpayment submitted, waiting for staff
    {"status": Order.Status.JOB_REQUEST, "total": "1500.00", "balance_due": None,
     "payments": [pay("500.00", PENDING)]},
    # 2. Job Request: another pending claim
    {"status": Order.Status.JOB_REQUEST, "total": "2000.00", "balance_due": None,
     "payments": [pay("1000.00", PENDING)]},
    # 3. Job Request: downpayment accepted -> ready to move to Pending Edit
    {"status": Order.Status.JOB_REQUEST, "total": "1800.00", "balance_due": None,
     "payments": [pay("900.00", ACCEPTED)]},
    # 4. Pending Edit: Downpayment Paid
    {"status": Order.Status.PENDING_EDIT, "total": "2200.00", "balance_due": None,
     "payments": [pay("1100.00", ACCEPTED)]},
    # 5. Pending Edit: wrong amount rejected (exact amount requested), then paid correctly
    {"status": Order.Status.PENDING_EDIT, "total": "1600.00", "balance_due": None,
     "payments": [
         pay("300.00", REJECTED, hours=3, requested="800.00", reason="Wrong amount"),
         pay("800.00", ACCEPTED, hours=20),
     ]},
    # 6. Production: Downpayment Paid
    {"status": Order.Status.PRODUCTION, "total": "2500.00", "balance_due": None,
     "payments": [pay("1250.00", ACCEPTED)]},
    # 7. Production: Downpayment Paid
    {"status": Order.Status.PRODUCTION, "total": "1800.00", "balance_due": None,
     "payments": [pay("900.00", ACCEPTED)]},
    # 8. Production: final payment requested, customer has not paid yet ("Pay Here")
    {"status": Order.Status.PRODUCTION, "total": "3000.00", "balance_due": "1500.00",
     "payments": [pay("1500.00", ACCEPTED)]},
    # 9. Production: final payment submitted, waiting for staff review
    {"status": Order.Status.PRODUCTION, "total": "1200.00", "balance_due": "600.00",
     "payments": [
         pay("600.00", ACCEPTED, hours=3),
         pay("600.00", PENDING, BAL, hours=90),
     ]},
    # 10. Completed: final balance paid -> Fully Paid
    {"status": Order.Status.COMPLETED, "total": "2750.00", "balance_due": "1375.00",
     "payments": [
         pay("1375.00", ACCEPTED, hours=3),
         pay("1375.00", ACCEPTED, BAL, hours=90),
     ]},
]

def agreed_downpayment_for(scenario):
    amounts = [
        Decimal(p["amount"])
        for p in scenario["payments"]
        if p["purpose"] == DOWN and p["status"] != REJECTED
    ]
    return max(amounts) if amounts else None
class Command(BaseCommand):
    help = "Seed idempotent demo users, channels, designs, orders, leads, and activity logs."

    @transaction.atomic
    def handle(self, *args, **options):
        admin = self._user(
            "admin@blytz.demo",
            role=User.Role.ADMIN,
            is_staff=True,
            is_superuser=True,
            first_name="Ada",
            last_name="Admin",
            phone="09000000001",
        )
        staff_edit = self._user(
            "staff.accounting@blytz.demo",
            role=User.Role.STAFF,
            is_staff=True,
            can_edit_accounting=True,
            first_name="Sam",
            last_name="Ledger",
            phone="09000000002",
        )
        staff_view = self._user(
            "staff@blytz.demo",
            role=User.Role.STAFF,
            is_staff=True,
            can_edit_accounting=False,
            first_name="Riley",
            last_name="Ops",
            phone="09000000003",
        )

        customers = [
            self._user(
                f"customer{i}@blytz.demo",
                role=User.Role.CUSTOMER,
                first_name=f"Customer{i}",
                last_name="Demo",
                phone=f"0917000000{i}",
            )
            for i in range(1, 6)
        ]

        gcash = self._channel(
            kind=PaymentChannel.Kind.GCASH,
            display_name="Blytz GCash",
            account_name="Blytz Clothing",
            account_number="09171234567",
            instructions="Send payment then upload proof. Strictly no refunds.",
        )
        maya = self._channel(
            kind=PaymentChannel.Kind.MAYA,
            display_name="Blytz Maya",
            account_name="Blytz Clothing",
            account_number="09179876543",
            instructions="Include order ID in the note. Strictly no refunds.",
        )
        bank = self._channel(
            kind=PaymentChannel.Kind.BANK,
            display_name="Blytz Bank",
            account_name="Blytz Clothing Inc.",
            account_number="1234-5678-9012",
            instructions="Transfer then upload proof. Strictly no refunds.",
        )
        channels = [gcash, maya, bank]
        now = timezone.now()

        designs = []
        for i in range(1, 13):
            owner = customers[(i - 1) % len(customers)]
            design, _ = Design.objects.update_or_create(
                owner=owner,
                title=f"Demo Design {i:02d}",
                defaults={
                    "garment_template": ("tee", "polo", "hoodie", "jersey")[
                        (i - 1) % 4
                    ],
                    "garment_color": ["black", "white", "navy"][i % 3],
                    "canvas_json": {"version": 1, "objects": [], "demo": i},
                },
            )
            designs.append(design)
            ActivityLog.objects.get_or_create(
                customer=owner,
                design=design,
                kind=ActivityLog.Kind.DESIGN_CREATED,
                defaults={},
            )

        lead_stages = [
            Lead.Stage.NEW_LEAD,
            Lead.Stage.ORDER_CONFIRMED,
            Lead.Stage.DESIGN_REVIEW,
            Lead.Stage.APPROVED,
            Lead.Stage.COMPLETED,
            Lead.Stage.LOST,
            Lead.Stage.DESIGN_REVIEW,
            Lead.Stage.ORDER_CONFIRMED,
            Lead.Stage.NEW_LEAD,
            Lead.Stage.APPROVED,
        ]

        # First 10 designs get orders (submitted); last 2 stay unsubmitted drafts
        for idx, design in enumerate(designs[:10]):
            sc = SCENARIOS[idx]

            order, created = Order.objects.get_or_create(
                design=design,
                defaults={
                    "customer": design.owner,
                    "canvas_json_snapshot": design.canvas_json,
                    "status": sc["status"],
                    "agreed_total": sc["total"],
                    "agreed_downpayment": agreed_downpayment_for(sc),
                    "balance_due": sc["balance_due"],
                    "notes": f"Demo order for {design.title}",
                },
            )
            if not created:
                order.customer = design.owner
                order.canvas_json_snapshot = design.canvas_json
                order.status = sc["status"]
                order.agreed_total = sc["total"]
                order.agreed_downpayment = agreed_downpayment_for(sc)
                order.balance_due = sc["balance_due"]
                order.notes = f"Demo order for {design.title}"
                order.save()

            # Spread order created_at across the last 60 days for realistic charts.
            order_days_ago = 2 + (idx * 6) % 55
            order_created = now - timedelta(days=order_days_ago, hours=idx % 12)
            Order.objects.filter(pk=order.pk).update(created_at=order_created)
            order.created_at = order_created

            if not order.preview_image:
                order.preview_image.save(
                    f"{order.order_id}-front.png",
                    placeholder_preview(f"{order.order_id}-front", (210, 210, 215)),
                    save=True,
                )
            if not order.preview_back_image:
                order.preview_back_image.save(
                    f"{order.order_id}-back.png",
                    placeholder_preview(f"{order.order_id}-back", (190, 195, 205)),
                    save=True,
                )

            # Phase history spread across the last 60 days (idempotent rebuild).
            OrderPhaseChange.objects.filter(order=order).delete()
            try:
                target_idx = Order.PHASE_FLOW.index(order.status)
            except ValueError:
                target_idx = 0
            for step in range(target_idx):
                days_ago = max(1, order_days_ago - (step + 1) * 3)
                OrderPhaseChange.objects.create(
                    order=order,
                    from_status=Order.PHASE_FLOW[step],
                    to_status=Order.PHASE_FLOW[step + 1],
                    changed_by=staff_edit if step % 2 == 0 else staff_view,
                    changed_at=now - timedelta(days=days_ago, hours=step),
                )

            ActivityLog.objects.get_or_create(
                customer=design.owner,
                design=design,
                order=order,
                kind=ActivityLog.Kind.DESIGN_SUBMITTED,
            )
            if order.status != Order.Status.JOB_REQUEST:
                ActivityLog.objects.get_or_create(
                    customer=design.owner,
                    design=design,
                    order=order,
                    kind=ActivityLog.Kind.ORDER_CONFIRMED,
                )

            # Payments: rebuilt from the scenario so the derived payment status
            # (Outstanding / Downpayment Paid / Fully Paid) matches the live flow.
            Payment.objects.filter(order=order).delete()
            for n, spec in enumerate(sc["payments"], start=1):
                channel_obj = channels[(idx + n) % len(channels)]
                reference = str(8100000000000 + order.pk * 100 + n)  # e-wallet style
                payment = Payment.objects.create(
                    order=order,
                    channel=channel_obj,
                    amount_claimed=spec["amount"],
                    status=spec["status"],
                    purpose=spec["purpose"],
                    requested_amount=spec["requested"],
                    rejection_reason=spec["reason"],
                    reference_number=reference,
                    proof_file=placeholder_proof(
                        f"{order.order_id}-{n}",
                        channel=channel_obj.display_name,
                        amount=spec["amount"],
                        reference=reference,
                    ),
                )
                created_at = order_created + timedelta(hours=spec["hours"])
                updates = {"created_at": created_at}
                if spec["status"] in (ACCEPTED, REJECTED):
                    updates["reviewed_at"] = created_at + timedelta(hours=2)
                    updates["reviewed_by"] = staff_edit
                Payment.objects.filter(pk=payment.pk).update(**updates)
            
            if idx == 3:  # Pending Edit order: customer already approved the final design
                order.final_design.save(
                    f"{order.order_id}-final-v1.png",
                    placeholder_preview(f"{order.order_id}-final", (230, 230, 235)),
                    save=False,
                )
                order.final_design_version = 1
                order.final_design_uploaded_at = order_created + timedelta(days=1)
                order.approved_version = 1
                order.approved_at = order_created + timedelta(days=2)
                order.save()
                
            Lead.objects.update_or_create(
                order=order,
                defaults={
                    "customer": design.owner,
                    "stage": lead_stages[idx],
                },
            )

        # Ensure every lead stage exists (already covered above)
        stages_present = set(Lead.objects.values_list("stage", flat=True))
        for stage, _label in Lead.Stage.choices:
            if stage not in stages_present:
                self.stderr.write(self.style.WARNING(f"Missing lead stage: {stage}"))

        # Quick self-check: show the derived payment status mix
        mix = {}
        for o in Order.objects.prefetch_related("payments"):
            mix[o.payment_status] = mix.get(o.payment_status, 0) + 1
        waiting = Payment.objects.filter(status=PENDING).count()

        self.stdout.write(self.style.SUCCESS("Demo data seeded (idempotent)."))
        self.stdout.write(
            f"Admin: {admin.email} / Staff: {staff_edit.email}, {staff_view.email} "
            f"/ Customers: {len(customers)} / Designs: {Design.objects.count()} "
            f"/ Orders: {Order.objects.count()} / Channels: {PaymentChannel.objects.filter(is_active=True).count()}"
        )
        self.stdout.write(
            "Payment status mix: "
            + ", ".join(f"{k}: {v}" for k, v in sorted(mix.items()))
            + f" / Payments awaiting review: {waiting}"
        )
        self.stdout.write(
            "Try: customer3 (Pay Here), customer4 (final payment waiting for review), "
            "customer5 (Fully Paid + rejected history)."
        )
        self.stdout.write(f"Password for all demo users: {DEMO_PASSWORD}")

    def _user(self, email, role, **extra):
        defaults = {
            "role": role,
            "is_active": True,
            **extra,
        }
        user, created = User.objects.get_or_create(email=email, defaults=defaults)
        if created:
            user.set_password(DEMO_PASSWORD)
            user.save()
        else:
            for key, value in defaults.items():
                setattr(user, key, value)
            user.set_password(DEMO_PASSWORD)
            user.save()
        return user

    def _channel(self, *, kind, display_name, account_name, account_number, instructions):
        channel, created = PaymentChannel.objects.update_or_create(
            kind=kind,
            display_name=display_name,
            defaults={
                "account_name": account_name,
                "account_number": account_number,
                "instructions": instructions,
                "is_active": True,
            },
        )
        if created or not channel.qr_image:
            channel.qr_image.save(
                f"{kind}-qr.png",
                placeholder_qr(kind),
                save=True,
            )
        return channel