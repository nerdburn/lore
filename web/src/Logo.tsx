export function Logo({ className = 'size-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <rect x="7" y="8" width="5" height="16" rx="1.5" fill="var(--accent-foreground)" />
      <rect x="14" y="8" width="5" height="11" rx="1.5" fill="var(--accent-foreground)" />
      <rect x="21" y="8" width="5" height="7" rx="1.5" fill="var(--accent-foreground)" />
    </svg>
  )
}
