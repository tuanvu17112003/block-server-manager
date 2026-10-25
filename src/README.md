# src — UI primitives note

shadcn install is deferred to keep the MVP dependency-free.

`src/components/ui.tsx` provides hand-rolled Tailwind-only primitives
(Button, Card, Badge, Field, Confirm, Modal, …) whose class names mirror
shadcn conventions, so a later swap to shadcn + Radix is a drop-in
replacement without touching call sites.
