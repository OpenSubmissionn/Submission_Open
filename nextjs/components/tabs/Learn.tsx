'use client';

import type { LearnCard, LearnPayload } from '@/lib/types';

interface LearnProps {
  learn: LearnPayload;
}

export function Learn({ learn }: LearnProps): React.JSX.Element {
  const sections: Array<{ id: string; title: string; cards: LearnCard[] }> = [
    { id: 'programs', title: 'Programas', cards: learn.programs },
    { id: 'accounts', title: 'Contas e PDAs', cards: learn.accounts },
    { id: 'concepts', title: 'Conceitos', cards: learn.concepts },
  ];

  const hasContent = sections.some((section) => section.cards.length > 0);
  if (!hasContent) {
    return (
      <p className="glass-soft p-6 text-center text-sm text-fg-dim">
        Nenhum material contextual disponível para esta transação.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {sections.map((section) =>
        section.cards.length > 0 ? (
          <section key={section.id} aria-labelledby={`learn-${section.id}`}>
            <h3
              id={`learn-${section.id}`}
              className="mb-3 text-xs font-semibold uppercase tracking-wide text-fg-mute"
            >
              {section.title}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {section.cards.map((card) => (
                <article key={card.name} className="glass-soft p-4">
                  <h4 className="text-sm font-semibold text-fg">{card.name}</h4>
                  <p className="mt-1.5 text-sm leading-relaxed text-fg-dim">{card.description}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}
