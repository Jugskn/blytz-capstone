from django.db.models import Q

from apps.designs.models import ActivityLog
from apps.orders.models import OrderPhaseChange, Payment

_TYPE_BY_KIND = {
    ActivityLog.Kind.DESIGN_CREATED: "design",
    ActivityLog.Kind.DESIGN_SUBMITTED: "design",
    ActivityLog.Kind.DESIGN_REVISED: "design",
    ActivityLog.Kind.DESIGN_APPROVED: "design",
    ActivityLog.Kind.ORDER_CONFIRMED: "order",
    ActivityLog.Kind.LEAD_STAGE_CHANGED: "lead",
    ActivityLog.Kind.PRICING_UPDATED: "payment",
    ActivityLog.Kind.FINAL_PAYMENT_REQUESTED: "payment",
}

_TYPE_LABEL = {
    "design": "Design",
    "order": "Order",
    "lead": "Lead",
    "job": "Job",
    "payment": "Payment",
}


def _who(user):
    if not user:
        return ""
    return user.get_full_name() or user.email


def build_order_timeline(order):
    """
    Every event for ONE order, newest first.

    Only rows tied to this order are included, so a customer's other orders
    never leak in. Design-creation rows made before the order existed are
    included because they belong to this order's design (one order per design).
    """
    if order is None:
        return []

    entries = []

    def add(when, kind, title, detail="", actor=""):
        entries.append(
            {
                "when": when,
                "type": kind,
                "label": _TYPE_LABEL[kind],
                "title": title,
                "detail": detail,
                "actor": actor,
                "order_id": order.order_id,
            }
        )

    # 1. Activity log (phase moves are shown from OrderPhaseChange below).
    logs = ActivityLog.objects.filter(
        Q(order=order) | Q(design_id=order.design_id, order__isnull=True)
    ).exclude(kind=ActivityLog.Kind.PHASE_MOVED)
    for log in logs:
        add(
            log.created_at,
            _TYPE_BY_KIND.get(log.kind, "order"),
            log.get_kind_display(),
            detail=log.detail,
        )

    # 2. Job status changes
    for change in OrderPhaseChange.objects.filter(order=order).select_related(
        "changed_by"
    ):
        add(
            change.changed_at,
            "job",
            f"{change.get_from_status_display()} → {change.get_to_status_display()}",
            actor=_who(change.changed_by) or "System",
        )

    # 3. Payments
    payments = Payment.objects.filter(order=order).select_related(
        "channel", "reviewed_by", "recorded_by"
    )
    for p in payments:
        kind_label = p.get_purpose_display().lower()
        amount = f"₱{p.amount_claimed:,.2f}"

        if p.is_manual_adjustment:
            add(
                p.created_at,
                "payment",
                f"Manual payment recorded: {amount} ({kind_label})",
                detail=p.note or "",
                actor=_who(p.recorded_by),
            )
            continue

        channel = p.channel.display_name if p.channel_id else "unknown channel"
        detail = channel
        if p.reference_number:
            detail += f" · Ref {p.reference_number}"
        add(
            p.created_at,
            "payment",
            f"Customer submitted {kind_label}: {amount}",
            detail=detail,
            actor=_who(order.customer),
        )
        if p.status == Payment.Status.ACCEPTED:
            add(
                p.reviewed_at or p.created_at,
                "payment",
                f"Payment accepted: {amount} ({kind_label})",
                actor=_who(p.reviewed_by),
            )
        elif p.status == Payment.Status.REJECTED:
            parts = []
            if p.rejection_reason:
                parts.append(p.rejection_reason)
            if p.requested_amount:
                parts.append(f"Requested exact amount ₱{p.requested_amount:,.2f}")
            add(
                p.reviewed_at or p.created_at,
                "payment",
                f"Payment rejected: {amount}",
                detail=" · ".join(parts),
                actor=_who(p.reviewed_by),
            )

    entries.sort(key=lambda e: e["when"], reverse=True)
    return entries