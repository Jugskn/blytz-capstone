from io import BytesIO

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand
from django.db import transaction
from PIL import Image

from apps.accounts.models import User
from apps.designs.models import ActivityLog, Design
from apps.orders.models import Order, Payment, PaymentChannel
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

        designs = []
        for i in range(1, 13):
            owner = customers[(i - 1) % len(customers)]
            design, _ = Design.objects.update_or_create(
                owner=owner,
                title=f"Demo Design {i:02d}",
                defaults={
                    "garment_template": "tee" if i % 2 else "hoodie",
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

        # First 10 designs get orders (submitted); last 2 stay unsubmitted drafts
        statuses = [
            Order.Status.JOB_REQUEST,
            Order.Status.JOB_REQUEST,
            Order.Status.PENDING_EDIT,
            Order.Status.PENDING_EDIT,
            Order.Status.PRODUCTION,
            Order.Status.PRODUCTION,
            Order.Status.COMPLETED,
            Order.Status.COMPLETED,
            Order.Status.PENDING_EDIT,
            Order.Status.PRODUCTION,
        ]
        # agreed totals: some fully paid, some outstanding, one unset
        pricing = [
            ("1500.00", "1500.00"),  # fully paid
            ("2000.00", "500.00"),  # outstanding
            ("1800.00", "1800.00"),  # fully
            ("2200.00", "1000.00"),  # outstanding
            ("1600.00", "1600.00"),  # fully
            ("2500.00", "0.00"),  # outstanding (no payment yet beyond 0)
            ("3000.00", "3000.00"),  # fully
            ("1200.00", "400.00"),  # outstanding
            (None, "300.00"),  # no agreed total yet — outstanding
            ("2750.00", "2750.00"),  # fully
        ]
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

        for idx, design in enumerate(designs[:10]):
            order, created = Order.objects.get_or_create(
                design=design,
                defaults={
                    "customer": design.owner,
                    "canvas_json_snapshot": design.canvas_json,
                    "status": statuses[idx],
                    "agreed_total": pricing[idx][0],
                    "notes": f"Demo order for {design.title}",
                },
            )
            if not created:
                order.customer = design.owner
                order.canvas_json_snapshot = design.canvas_json
                order.status = statuses[idx]
                order.agreed_total = pricing[idx][0]
                order.notes = f"Demo order for {design.title}"
                order.save()

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

            claimed = pricing[idx][1]
            channel = gcash if idx % 2 == 0 else maya
            if claimed and claimed != "0.00":
                Payment.objects.update_or_create(
                    order=order,
                    channel=channel,
                    defaults={"amount_claimed": claimed},
                )
            else:
                Payment.objects.filter(order=order).delete()

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

        self.stdout.write(self.style.SUCCESS("Demo data seeded (idempotent)."))
        self.stdout.write(
            f"Admin: {admin.email} / Staff: {staff_edit.email}, {staff_view.email} "
            f"/ Customers: {len(customers)} / Designs: {Design.objects.count()} "
            f"/ Orders: {Order.objects.count()} / Channels: {PaymentChannel.objects.filter(is_active=True).count()}"
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
