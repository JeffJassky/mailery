/* Condition tooltip: a predicate as a short outline ("Sent only if all of: • … "). */
import React from 'react'
import { OUTLINE_GROUP_WORDS, outlinePredicate, outlineText, type PredicateOutline } from '../../../shared/program-board'
import type { Predicate } from '../../../shared/types'
import { Tip } from '../../components/tip'

function Items({ items }: { items: PredicateOutline[] }) {
  return (
    <ul className="cond-list">
      {items.map((it, i) =>
        it.kind === 'line' ? (
          <li key={i}>{it.text}</li>
        ) : (
          <li key={i}>
            <span className="cond-group">{OUTLINE_GROUP_WORDS[it.mode]}:</span>
            <Items items={it.items} />
          </li>
        ),
      )}
    </ul>
  )
}

export function PredicateTip({ title, predicate, children }: { title: string; predicate: Predicate; children: React.ReactNode }) {
  const o = outlinePredicate(predicate)
  const body =
    o.kind === 'line' ? (
      <span className="cond">
        <span className="cond-title">{title}</span>
        <span className="cond-line">{o.text}</span>
      </span>
    ) : (
      <span className="cond">
        <span className="cond-title">
          {title} {OUTLINE_GROUP_WORDS[o.mode]}:
        </span>
        <Items items={o.items} />
      </span>
    )
  return (
    <Tip label={outlineText(title, o)} content={body} focusable>
      {children}
    </Tip>
  )
}
