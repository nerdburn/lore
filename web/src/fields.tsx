import { Label, ListBox, Select } from '@heroui/react'
import type { Key } from 'react'

/** A labelled single-choice Select over fixed options. */
export function ChoiceSelect<T extends string>({
  label,
  value,
  options,
  render,
  onChange,
  isDisabled,
  placeholder,
  className = 'w-full',
}: {
  label: string
  value: T | undefined
  options: readonly T[]
  render: (v: T) => string
  onChange: (v: T) => void
  isDisabled?: boolean
  placeholder?: string
  className?: string
}) {
  return (
    <Select className={className} selectedKey={value ?? null} onSelectionChange={(k: Key | null) => k !== null && onChange(String(k) as T)} isDisabled={isDisabled} placeholder={placeholder ?? 'None'}>
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o} id={o} textValue={render(o)}>
              {render(o)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

export const splitLabels = (s: string) =>
  s
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean)
