import { Icons } from '../../components/icons'
import { Tip } from '../../components/tip'
import type { PolicyChip } from './policy-format'

/** Read-only chips. In edit mode WP-C swaps in `EditableChips`. */
export function PolicyChips({ chips }: { chips: PolicyChip[] }) {
  return (
    <div className="pb-chips">
      {chips.map((c) => {
        const Icon = Icons[c.icon]
        return (
          <Tip key={c.key} label={c.tip} focusable>
            <span className="pb-chip">
              <Icon />
              <span>{c.value}</span>
            </span>
          </Tip>
        )
      })}
    </div>
  )
}
