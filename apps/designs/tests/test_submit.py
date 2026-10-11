from datetime import timedelta
from decimal import Decimal
from io import BytesIO

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from PIL import Image

from apps.designs.models import ActivityLog, Design
from apps.orders.models import Order, Payment, PaymentChannel
from apps.sales.models import Lead

User = get_user_model()


def _png_file(name="proof.png", size=(32, 32)):
    buffer = BytesIO()
    Image.new("RGB", size, color=(200, 162, 39)).save(buffer, format="PNG")
    return SimpleUploadedFile(name, buffer.getvalue(), content_type="image/png")


class DesignSubmitTests(TestCase):
    def setUp(self):
        self.customer = User.objects.create_user(
            email="buyer@example.com",
            password="test-pass-123",
            role=User.Role.CUSTOMER,
        )
        self.other = User.objects.create_user(
            email="other@example.com",
            password="test-pass-123",
            role=User.Role.CUSTOMER,
        )
        self.channel = PaymentChannel.objects.create(
            kind=PaymentChannel.Kind.GCASH,
            display_name="Test GCash",
            account_name="Blytz",
            account_number="09170001111",
            is_active=True,
        )
        self.design = Design.objects.create(
            owner=self.customer,
            title="Submit me",
            canvas_json={"version": 1, "objects": [{"type": "text"}]},
        )

    def _submit(
        self,
        user=None,
        design=None,
        *,
        window_started_at=None,
        proof=None,
        amount="500.00",
        channel=None,
    ):
        user = user or self.customer
        design = design or self.design
        self.client.force_login(user)
        started = window_started_at or timezone.now().isoformat()
        return self.client.post(
            reverse("design_submit", args=[design.pk]),
            {
                "channel": (channel or self.channel).pk,
                "amount_claimed": amount,
                "canvas_json": '{"version":1,"objects":[{"type":"rect"}]}',
                "window_started_at": started,
                "proof_file": proof if proof is not None else _png_file(),
            },
        )

    def test_submission_creates_order_payment_lead_and_activity_logs(self):
        before_orders = Order.objects.count()
        before_payments = Payment.objects.count()
        before_leads = Lead.objects.count()
        before_logs = ActivityLog.objects.count()

        response = self._submit()
        order = Order.objects.get(design=self.design)

        self.assertRedirects(
            response,
            reverse("order_detail", kwargs={"order_id": order.order_id}),
        )
        self.assertEqual(Order.objects.count(), before_orders + 1)
        self.assertEqual(Payment.objects.count(), before_payments + 1)
        self.assertEqual(Lead.objects.count(), before_leads + 1)
        self.assertEqual(ActivityLog.objects.count(), before_logs + 2)

        payment = Payment.objects.get(order=order)
        lead = Lead.objects.get(order=order)
        self.assertEqual(payment.amount_claimed, Decimal("500.00"))
        self.assertEqual(payment.channel_id, self.channel.pk)
        self.assertTrue(payment.proof_file)
        self.assertEqual(lead.stage, Lead.Stage.NEW_LEAD)
        self.assertEqual(order.canvas_json_snapshot.get("objects")[0]["type"], "rect")
        kinds = set(
            ActivityLog.objects.filter(order=order).values_list("kind", flat=True)
        )
        self.assertEqual(
            kinds,
            {
                ActivityLog.Kind.DESIGN_SUBMITTED,
                ActivityLog.Kind.ORDER_CONFIRMED,
            },
        )

    def test_expired_window_records_nothing(self):
        expired = (timezone.now() - timedelta(minutes=30)).isoformat()
        response = self._submit(window_started_at=expired)
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Order.objects.filter(design=self.design).exists())
        self.assertFalse(Payment.objects.exists())
        self.assertFalse(Lead.objects.filter(customer=self.customer).exists())

    def test_cancelled_prompt_records_nothing(self):
        """Cancel never POSTs submit — save-only leaves no order/payment/lead."""
        self.client.force_login(self.customer)
        self.client.post(
            reverse("design_save", args=[self.design.pk]),
            {"canvas_json": '{"version":1,"objects":[],"saved":true}'},
        )
        self.design.refresh_from_db()
        self.assertTrue(self.design.canvas_json.get("saved"))
        self.assertFalse(Order.objects.filter(design=self.design).exists())
        self.assertEqual(Payment.objects.count(), 0)
        self.assertEqual(Lead.objects.filter(customer=self.customer).count(), 0)

    def test_bad_file_types_rejected(self):
        bad = SimpleUploadedFile(
            "malware.exe",
            b"MZ\x00\x00not-an-image",
            content_type="application/octet-stream",
        )
        response = self._submit(proof=bad)
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Order.objects.filter(design=self.design).exists())

        oversized = _png_file("big.png")
        oversized.size = 6 * 1024 * 1024  # hint only; force via custom file
        big = SimpleUploadedFile(
            "big.png",
            b"0" * (5 * 1024 * 1024 + 1),
            content_type="image/png",
        )
        response = self._submit(proof=big)
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Order.objects.filter(design=self.design).exists())

    def test_customer_cannot_submit_another_customers_design(self):
        response = self._submit(user=self.other)
        self.assertEqual(response.status_code, 404)
        self.assertFalse(Order.objects.filter(design=self.design).exists())

    def test_editor_page_loads_for_owner(self):
        self.client.force_login(self.customer)
        response = self.client.get(reverse("design_editor", args=[self.design.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="editor-root"')
        self.assertContains(response, "Strictly no refunds")
        self.assertContains(response, "editor_contract.js")
        self.assertContains(response, "fabric.min.js")
        self.assertContains(response, "blytz-fabric-canvas")
