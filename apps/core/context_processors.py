from datetime import timedelta

from django.conf import settings
from django.utils import timezone


def _staff_notifications():
    from apps.orders.models import Order, Payment

    pending_qs = Payment.objects.filter(status=Payment.Status.PENDING)
    pending_count = pending_qs.count()
    pending_list = list(
        pending_qs.select_related("order", "order__customer").order_by("created_at")[:5]
    )
    job_requests = Order.objects.filter(
        status=Order.Status.JOB_REQUEST
    ).prefetch_related("payments")
    ready_count = sum(
        1 for o in job_requests if o.payment_status == Order.DOWNPAYMENT_PAID
    )
    return {
        "staff_pending_payments": pending_list,
        "staff_pending_payments_count": pending_count,
        "staff_ready_to_move_count": ready_count,
        "staff_notification_count": pending_count + ready_count,
    }


def _customer_notifications(user):
    from apps.orders.models import Order, Payment

    orders = list(
        Order.objects.filter(customer=user)
        .select_related("design")
        .prefetch_related("payments")
        .order_by("-created_at")[:20]
    )
    week_ago = timezone.now() - timedelta(days=7)
    actions = []
    updates = []
    for order in orders:
        rejected = order.rejected_request
        if rejected is not None:
            actions.append(
                {
                    "kind": "rejected",
                    "order": order,
                    "amount": rejected.requested_amount,
                    "reason": rejected.rejection_reason,
                }
            )
        else:
            due = order.amount_due
            if due is not None:
                actions.append({"kind": "due", "order": order, "amount": due})
        for payment in order.payments.all():
            if (
                payment.status == Payment.Status.ACCEPTED
                and not payment.is_manual_adjustment
                and payment.reviewed_at
                and payment.reviewed_at >= week_ago
            ):
                updates.append({"order": order, "payment": payment})
    updates.sort(key=lambda u: u["payment"].reviewed_at, reverse=True)
    return {
        "customer_actions": actions,
        "customer_updates": updates[:5],
        "customer_notification_count": len(actions),
    }


def blytz(request):
    username = settings.MESSENGER_PAGE_USERNAME or ""
    context = {
        "MESSENGER_PAGE_USERNAME": username,
        "messenger_url": f"https://m.me/{username}" if username else "",
        "PAYMENT_WINDOW_MINUTES": settings.PAYMENT_WINDOW_MINUTES,
        "PROOF_MAX_UPLOAD_MB": settings.PROOF_MAX_UPLOAD_MB,
        "DEBUG": settings.DEBUG,
    }
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated:
        if getattr(user, "is_staff_role", False):
            context.update(_staff_notifications())
        elif getattr(user, "is_customer", False):
            context.update(_customer_notifications(user))
    return context