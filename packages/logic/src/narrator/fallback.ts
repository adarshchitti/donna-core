import { neutraliseLine } from './forbidden.js';
import { PROFILE_SECTION_TITLES } from './prompt.js';
import type { NarratorDraft, NarratorInput, NarratorSignalView } from './types.js';

/**
 * The fallback briefing -- built by CODE, no model involved.
 *
 * The product degrades to a cited table, never to silence. This runs when
 * narration fails twice, when the response fails the post-processor, and when
 * there is no API key at all, which is what makes the whole package work
 * offline.
 *
 * It is expressed as a DRAFT, not as a finished Briefing, so it goes through
 * exactly the same `postProcess` gate as model output. That is deliberate: a
 * second path to a published briefing is a second place for the rules to be
 * wrong. It therefore carries inline [signal_id] markers like a real draft.
 */

const money = (usd: number): string => {
  const n = Math.abs(usd);
  if (n >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${usd}`;
};

const cite = (ids: readonly string[]): string => ids.map((id) => `[${id}]`).join(' ');

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const OFFICER_TYPES = /officer|exec|director|management|leadership/i;

export const buildFallbackDraft = (input: NarratorInput): NarratorDraft => {
  const { cluster } = input;

  // Only signals this cluster actually cites can appear, because postProcess
  // would strip anything else and leave what_changed shorter than it looks.
  const cited = new Set(cluster.signals);
  const signals: NarratorSignalView[] = input.signals.filter(
    (s) => cited.has(s.signal_id) && s.company_id === cluster.company_id,
  );
  if (signals.length === 0) {
    // Nothing citable means nothing publishable. The validator does not emit a
    // cluster with no signals, so reaching here is a caller bug, and failing
    // loudly beats shipping a briefing that cites nothing.
    throw new Error(
      `narrator: cannot build a fallback for cluster ${cluster.cluster_id} with no resolvable signals`,
    );
  }

  const signalIds = signals.map((s) => s.signal_id);
  const dealIds = cluster.deals.map((d) => d.deal_id);
  const allCites = cite(signalIds);

  // --- headline: plain, factual, cited. No adjectives. -------------------
  const headline =
    cluster.mode === 'profile'
      ? `Starting profile for ${cluster.company_id}: ${signals.length} ${plural(signals.length, 'baseline observation', 'baseline observations')} recorded ${allCites}.`
      : `${signals.length} ${plural(signals.length, 'observation', 'observations')} recorded for ${cluster.company_id} in the window ${cluster.window.from} to ${cluster.window.to} ${allCites}.`;

  // --- what_changed: one line per signal, its own summary_fact -----------
  // `neutraliseLine` is here because summary_fact is derived from source
  // records upstream, and a court docket really can contain the word "breach".
  // The fallback cannot reject itself, so it substitutes a neutral line and
  // leaves the original wording to the evidence panel.
  const what_changed = signals.map((s) => ({
    text: neutraliseLine(s.summary_fact),
    signal_id: s.signal_id,
  }));

  // --- why_it_matters: assembled from the deal fields --------------------
  const why: string[] = [];
  if (cluster.deals.length > 0) {
    why.push(
      `These observations relate to ${cluster.deals.length} linked ${plural(cluster.deals.length, 'agreement', 'agreements')} with ${money(cluster.exposure.annual_value_usd)} total annual value ${cite(dealIds)}.`,
    );
    const top = [...cluster.deals].sort((a, b) => b.exposure_weight - a.exposure_weight)[0];
    if (top !== undefined) {
      const parts = [
        top.notice_days !== undefined ? `a notice period of ${top.notice_days} days` : null,
        `${top.days_to_renewal} days to the stated end date`,
        top.share_pct !== undefined ? `${top.share_pct}% of the stated revenue share` : null,
        `agreement class on record "${top.class}"`,
      ].filter((p): p is string => p !== null);
      why.push(`The largest linked agreement has ${parts.join(', ')} ${cite([top.deal_id])}.`);
    }
    if (cluster.deals.some((d) => d.compliance_flag)) {
      why.push(
        `At least one linked agreement is recorded as tied, which is a compliance question rather than a larger exposure ${cite(dealIds)}.`,
      );
    }
  } else {
    // An absence statement, so it needs no citation -- and it is the honest
    // thing to print when nobody has linked a deal yet.
    why.push('No linked agreement is recorded for this company, so deal context is not available.');
  }
  why.push('Worth discussing the observed changes in the context of the agreement.');

  // --- confidence_note: what is reported versus confirmed ----------------
  const soft = signals.filter((s) => s.confidence === 'medium' || s.confidence === 'low');
  const confidence_note =
    soft.length > 0
      ? `${soft.length} of ${signals.length} cited ${plural(signals.length, 'observation is', 'observations are')} reported rather than confirmed ${cite(soft.map((s) => s.signal_id))}. A recorded claim or notice is not a determination of wrongdoing.`
      : `The cited observations come from primary records ${allCites}. A recorded claim or notice is not a determination of wrongdoing.`;

  // --- verify: only when the cluster asks for it (rule 6) ----------------
  const verify = cluster.verify_with_counterparty
    ? `Confirm the recorded ${plural(signals.length, 'change', 'changes')} with the counterparty, and whether any watched term in the agreement is affected ${allCites}.`
    : null;

  const draft: NarratorDraft = {
    headline,
    what_changed,
    why_it_matters: why.join(' '),
    verify,
    confidence_note,
  };

  if (cluster.mode !== 'profile') return draft;

  // --- profile sections -------------------------------------------------
  const officerSignals = signals.filter((s) => OFFICER_TYPES.test(s.type));
  const behaviour = signals
    .slice(0, 3)
    .map((s) => `${neutraliseLine(s.summary_fact).replace(/\.?$/, '')} ${cite([s.signal_id])}.`)
    .join(' ');

  return {
    ...draft,
    sections: [
      { title: PROFILE_SECTION_TITLES[0], text: behaviour, signal_id: signalIds[0] },
      officerSignals.length > 0
        ? {
            title: PROFILE_SECTION_TITLES[1],
            text: officerSignals
              .map((s) => `${neutraliseLine(s.summary_fact).replace(/\.?$/, '')} ${cite([s.signal_id])}.`)
              .join(' '),
            signal_id: officerSignals[0]?.signal_id,
          }
        : {
            title: PROFILE_SECTION_TITLES[1],
            text: 'Officer churn is not observed in the history available to us.',
            gap: true,
          },
      {
        title: PROFILE_SECTION_TITLES[2],
        text: 'Payment behaviour and relationship sentiment are not covered by this system.',
        gap: true,
      },
      {
        title: PROFILE_SECTION_TITLES[3],
        text: 'Consider confirming the legal entity and any watched terms directly with the counterparty.',
        gap: true,
      },
    ],
  };
};
