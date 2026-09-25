import { PersonPlus } from '@gravity-ui/icons'
import { Autocomplete, Button, EmptyState, Label, ListBox, SearchField, Select, Tag, TagGroup, Tooltip, useFilter } from '@heroui/react'
import { useState, type Key } from 'react'

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

const CREATE = '__create:'
/** What the create option reads as (screen readers, the filter). */
const CREATE_TEXT = 'Create label “'

/**
 * Labels as a multi-select: the project's existing labels to pick from
 * (shown as removable chips once chosen), search to narrow them, and
 * "Create “…”" when what you typed isn't a label yet — so the project's
 * spelling of a label wins over a near-duplicate.
 */
export function LabelPicker({ value, options, onChange, isDisabled, label = 'Labels' }: { value: string[]; options: string[]; onChange: (labels: string[]) => void; isDisabled?: boolean; label?: string }) {
  const [query, setQuery] = useState('')
  const { contains } = useFilter({ sensitivity: 'base' })
  const all = [...new Set([...options, ...value])].sort((a, b) => a.localeCompare(b))
  const q = query.trim().replace(/\s+/g, ' ')
  const exists = all.some((l) => l.toLowerCase() === q.toLowerCase())
  const items = [...(q && !exists ? [{ id: `${CREATE}${q}`, text: q, create: true }] : []), ...all.map((l) => ({ id: l, text: l, create: false }))]

  return (
    <Autocomplete
      className="w-full"
      placeholder="No labels"
      selectionMode="multiple"
      value={value}
      isDisabled={isDisabled}
      onChange={(keys) => {
        const next = ((keys as Key[] | null) ?? []).map(String).map((k) => (k.startsWith(CREATE) ? k.slice(CREATE.length) : k))
        setQuery('')
        onChange([...new Set(next)])
      }}
    >
      <Label>{label}</Label>
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {({ defaultChildren, isPlaceholder }) =>
            isPlaceholder || value.length === 0 ? (
              defaultChildren
            ) : (
              <TagGroup size="sm" onRemove={(keys) => onChange(value.filter((l) => !keys.has(l)))}>
                <TagGroup.List>
                  {value.map((l) => (
                    <Tag key={l} id={l}>
                      {l}
                    </Tag>
                  ))}
                </TagGroup.List>
              </TagGroup>
            )
          }
        </Autocomplete.Value>
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <Autocomplete.Popover>
        <Autocomplete.Filter inputValue={query} onInputChange={setQuery} filter={(text, input) => text.startsWith(CREATE_TEXT) || contains(text, input)}>
          <SearchField autoFocus aria-label="Search or create a label" name="label-search" variant="secondary">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="Search or create…" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <ListBox renderEmptyState={() => <EmptyState>Type to create a label</EmptyState>}>
            {items.map((i) => (
              <ListBox.Item key={i.id} id={i.id} textValue={i.create ? `${CREATE_TEXT}${i.text}”` : i.text}>
                {i.create ? (
                  <span>
                    Create <span className="font-medium">“{i.text}”</span>
                  </span>
                ) : (
                  i.text
                )}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Autocomplete.Filter>
      </Autocomplete.Popover>
    </Autocomplete>
  )
}

/** The round "Assign to me" button beside an Assignee select; filled while the ticket is yours. */
export function AssignToMe({ me, current, onAssign, isDisabled }: { me: string; current?: string; onAssign: (who: string) => void; isDisabled?: boolean }) {
  const mine = current === me
  return (
    <Tooltip delay={150} closeDelay={0}>
      <Button isIconOnly aria-label="Assign to me" variant={mine ? 'primary' : 'secondary'} className="shrink-0 rounded-full" isDisabled={isDisabled} onPress={() => !mine && onAssign(me)}>
        <PersonPlus />
      </Button>
      <Tooltip.Content>
        <p className="text-xs">{mine ? 'Assigned to you' : 'Assign to me'}</p>
      </Tooltip.Content>
    </Tooltip>
  )
}
