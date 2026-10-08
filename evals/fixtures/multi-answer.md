# Quartz Queue

Quartz Queue is a managed message queue for small teams. It is designed so that producers never wait for consumers.

## Delivery guarantees

Quartz Queue offers three delivery guarantees: at-most-once, at-least-once and exactly-once.
Exactly-once delivery needs an idempotency key on every message and is only available on the Pro plan.
At-least-once is the default, and a consumer may therefore see the same message twice after a timeout.

## Features on every plan

Dead-letter queues, delayed delivery and message priorities are included on every plan, including the free one.
Message ordering is guaranteed only inside a single message group, never across groups.
Messages are encrypted at rest with a key that the customer can rotate at any time.

## Limits

A message can be at most 256 kilobytes. Larger payloads must be stored elsewhere and referenced by link.
The free plan allows one million requests per month; the Pro plan has no request limit.
Retention is four days by default and can be raised to fourteen days on the Pro plan.
