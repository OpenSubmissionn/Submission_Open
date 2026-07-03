'use client';

import type { LearnCard, LearnPayload } from '@/lib/types';

interface LearnProps {
  learn: LearnPayload;
}

export function Learn({ learn }: LearnProps): React.JSX.Element {
  const sections: Array<{ id: string; title: string; cards: LearnCard[] }> = [
    { id: 'programs', title: 'Programas envolvidos', cards: learn.programs },
    { id: 'accounts', title: 'Contas e PDAs', cards: learn.accounts },
    { id: 'concepts', title: 'Conceitos', cards: learn.concepts },
  ];

  const hasContent = sections.some((section) => section.cards.length > 0);
  if (!hasContent) {
    return (
      <p className="learn-empty">
        Nenhum material contextual disponível para esta transação.
      </p>
    );
  }

  return (
    <div className="learn-stack">
      {sections.map((section) =>
        section.cards.length > 0 ? (
          <section key={section.id} aria-labelledby={`learn-${section.id}`}>
            <h3 id={`learn-${section.id}`} className="learn-section-head">
              {section.title}
            </h3>
            <div className="learn-cards">
              {section.cards.map((card, index) => (
                <article key={`${card.name}-${index}`} className="learn-card">
                  <div className="head">
                    <span className="info-pill" aria-hidden="true">
                      i
                    </span>
                    <h5>{card.name}</h5>
                  </div>
                  <p>{card.description}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}
