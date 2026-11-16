from decimal import Decimal

from django.test import TestCase
from django.urls import reverse

from apps.accounts.models import User
from apps.designs.models import Design
from apps.orders.models import Order, Payment

ACCEPTED = Payment.Status.ACCEPTED
PENDING = Payment.Status.PENDING
REJECTED = Payment.Status.REJECTED
DOWN = Payment.Purpose.DOWNPAYMENT
BAL = Payment.Purpose.BALANCE


class PaymentWorkflowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.customer = User.objects.create(
            email="c@test.demo", role=User.Role.CUSTOMER, is_active=True
        )
        cls.staff = User.objects.create(
            email="s@test.demo",
            role=User.Role.STAFF,
            is_staff=True,
            is_active=True,
        )

    # ---- helpers ----
    def make_order(self, status=Order.Status.JOB_REQUEST, **extra):
        n = Design.objects.count() + 1
        design = Design.objects.create(
            owner=self.customer,
            title=f"Test Design {n}",
            garment_template="tee",
            garment_color="black",
            canvas_json={},
        )
        return Order.objects.create(
            design=design,
            customer=self.customer,
            canvas_json_snapshot={},
            status=status,
            **extra,
        )

    def pay(self, order, amount, status, purpose=DOWN, **extra):
        return Payment.objects.create(
            order=order,
            amount_claimed=Decimal(amount),
            status=status,
            purpose=purpose,
            **extra,
        )

    # ---- status rules ----
    def test_no_payment_is_outstanding(self):
        order = self.make_order()
        self.assertEqual(order.payment_status, Order.OUTSTANDING)

    def test_pending_payment_is_not_counted(self):
        order = self.make_order()
        self.pay(order, "500.00", PENDING)
        self.assertEqual(order.payment_status, Order.OUTSTANDING)
        self.assertEqual(order.total_paid, Decimal("0.00"))

    def test_rejected_payment_is_not_counted_but_kept(self):
        order = self.make_order()
        self.pay(order, "300.00", REJECTED, requested_amount=Decimal("800.00"))
        self.assertEqual(order.payment_status, Order.OUTSTANDING)
        self.assertEqual(order.total_paid, Decimal("0.00"))
        self.assertEqual(Payment.objects.filter(order=order).count(), 1)

    def test_accepted_downpayment_is_downpayment_paid(self):
        order = self.make_order()
        self.pay(order, "500.00", ACCEPTED)
        self.assertEqual(order.payment_status, Order.DOWNPAYMENT_PAID)

    def test_balance_flow_outstanding_then_fully_paid(self):
        order = self.make_order(status=Order.Status.COMPLETED)
        self.pay(order, "500.00", ACCEPTED)
        order.balance_due = Decimal("500.00")
        order.save()
        order = Order.objects.get(pk=order.pk)
        self.assertEqual(order.payment_status, Order.OUTSTANDING)
        self.assertEqual(order.amount_due, Decimal("500.00"))

        self.pay(order, "500.00", ACCEPTED, purpose=BAL)
        order = Order.objects.get(pk=order.pk)
        self.assertEqual(order.payment_status, Order.FULLY_PAID)
        self.assertIsNone(order.amount_due)

    def test_rejection_with_exact_amount_sets_amount_due(self):
        order = self.make_order()
        self.pay(order, "300.00", REJECTED, requested_amount=Decimal("800.00"))
        order = Order.objects.get(pk=order.pk)
        self.assertEqual(order.amount_due, Decimal("800.00"))
        self.assertIsNotNone(order.rejected_request)

        # once the customer pays again, the request is resolved
        self.pay(order, "800.00", ACCEPTED)
        order = Order.objects.get(pk=order.pk)
        self.assertIsNone(order.rejected_request)
        self.assertIsNone(order.amount_due)

    # ---- staff actions (views) ----
    def test_staff_reject_saves_requested_amount(self):
        order = self.make_order()
        payment = self.pay(order, "300.00", PENDING)
        self.client.force_login(self.staff)
        self.client.post(
            reverse("review_payment", args=[order.order_id, payment.pk]),
            {
                "action": "reject",
                "rejection_reason": "Wrong amount",
                "requested_amount": "800",
            },
        )
        payment.refresh_from_db()
        self.assertEqual(payment.status, REJECTED)
        self.assertEqual(payment.requested_amount, Decimal("800.00"))

    def test_cannot_advance_without_downpayment_paid(self):
        order = self.make_order()
        self.pay(order, "500.00", PENDING)
        self.client.force_login(self.staff)
        self.client.post(reverse("advance_order_phase", args=[order.order_id]))
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.JOB_REQUEST)

    def test_can_advance_with_downpayment_paid(self):
        order = self.make_order()
        self.pay(order, "500.00", ACCEPTED)
        self.client.force_login(self.staff)
        self.client.post(reverse("advance_order_phase", args=[order.order_id]))
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PENDING_EDIT)

    def test_complete_requires_balance_and_sets_it(self):
        order = self.make_order(status=Order.Status.PRODUCTION)
        self.pay(order, "500.00", ACCEPTED)
        self.client.force_login(self.staff)
        url = reverse("advance_order_phase", args=[order.order_id])

        self.client.post(url)  # no balance entered
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.PRODUCTION)

        self.client.post(url, {"balance_due": "500"})
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.COMPLETED)
        self.assertEqual(order.balance_due, Decimal("500.00"))
        self.assertEqual(order.payment_status, Order.OUTSTANDING)

    def test_downpayment_and_balance_split(self):
        order = self.make_order(
            status=Order.Status.COMPLETED, balance_due=Decimal("500.00")
        )
        self.pay(order, "500.00", ACCEPTED)
        self.pay(order, "200.00", ACCEPTED, purpose=BAL)
        order = Order.objects.get(pk=order.pk)
        self.assertEqual(order.downpayment_paid, Decimal("500.00"))
        self.assertEqual(order.balance_paid, Decimal("200.00"))
        self.assertEqual(order.outstanding_amount, Decimal("300.00"))

    def test_staff_bell_counts_pending_payments(self):
        from django.test import RequestFactory
        from apps.core.context_processors import blytz

        order = self.make_order()
        self.pay(order, "500.00", PENDING)
        request = RequestFactory().get("/")
        request.user = self.staff
        self.assertEqual(blytz(request)["staff_pending_payments_count"], 1)

    def test_customer_bell_shows_exact_amount_request(self):
        from django.test import RequestFactory
        from apps.core.context_processors import blytz

        order = self.make_order()
        self.pay(order, "300.00", REJECTED, requested_amount=Decimal("800.00"))
        request = RequestFactory().get("/")
        request.user = self.customer
        ctx = blytz(request)
        self.assertEqual(ctx["customer_notification_count"], 1)
        self.assertEqual(ctx["customer_actions"][0]["amount"], Decimal("800.00"))