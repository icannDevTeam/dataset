/**
 * components/v2/PreviewModal.js
 *
 * Generic "report preview" modal used by all V2 analytics/reports pages.
 *
 * Behaviour
 * ─────────
 * 1. When `open` flips true, POSTs `{ ...body, preview: true }` to `endpoint`.
 * 2. Renders the standard preview payload returned by `lib/downloads-helpers.js`
 *    `buildPreview()`:
 *      { preview, title, subtitle, kpis, columns, sampleRows,
 *        totalRows, truncated, kind, sampleSize }
 * 3. Footer has ONE action: "Open in Downloads Hub for full export" —
 *    deep-links to `/v2/admin/downloads?card=<cardId>` so the user can
 *    pick format/filters there and trigger the rate-limited, audited
 *    download.
 *
 * Auth / errors
 * ─────────────
 *  - 401/403/reauth_required → show "needs re-auth or stronger
 *    permissions" message + same CTA into the Hub.
 *  - Network / 5xx → show error message, keep CTA available.
 *
 * No new deps — plain React + Tailwind. Styling mirrors the inline
 * PreviewModal already living inside pages/v2/admin/downloads.js so the
 * UX feels consistent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';

function safeCell(v) {
  if (v == null) return '';
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

export default function PreviewModal({
  open,
  onClose,
  endpoint,
  body = {},
  cardId,
  title: titleOverride,
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const reqIdRef = useRef(0);

  // Snapshot the body so changes mid-fetch don't re-trigger; user closes & re-opens to refresh.
  const bodyKey = useMemo(() => {
    try { return JSON.stringify(body); } catch { return ''; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setErr(null);
    setNeedsReauth(false);
    setData(null);

    (async () => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: 'xlsx', ...body, preview: true }),
        });
        if (cancelled || myReq !== reqIdRef.current) return;
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          let code = '';
          try {
            const j = await res.json();
            detail = j.message || j.error || detail;
            code = j.error || '';
          } catch {}
          if (res.status === 401 || res.status === 403 || /^reauth_/.test(code)) {
            setNeedsReauth(true);
            throw new Error(detail);
          }
          throw new Error(detail);
        }
        const payload = await res.json();
        if (cancelled || myReq !== reqIdRef.current) return;
        setData(payload);
      } catch (e) {
        if (cancelled || myReq !== reqIdRef.current) return;
        setErr(e.message || 'Preview failed');
      } finally {
        if (!cancelled && myReq === reqIdRef.current) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, endpoint, bodyKey]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const goToHub = () => {
    const url = cardId
      ? `/v2/admin/downloads?card=${encodeURIComponent(cardId)}`
      : '/v2/admin/downloads';
    onClose?.();
    router.push(url);
  };

  const cols = data?.columns || [];
  const rows = data?.sampleRows || [];
  const sampleSize = data?.sampleSize ?? rows.length;
  const totalRows = data?.totalRows ?? rows.length;
  const showingMore = totalRows > rows.length || data?.truncated;

  const headerTitle = data?.title || titleOverride || 'Report preview';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${headerTitle}`}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[88vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-700 bg-slate-950/40 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <i className="ph ph-eye text-lg text-teal-300" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-teal-300">Report preview</span>
            </div>
            <h3 className="text-base font-semibold text-white mt-1 truncate">{headerTitle}</h3>
            {data?.subtitle && <p className="text-xs text-slate-400 mt-0.5 truncate">{data.subtitle}</p>}
            {data?.range && <p className="text-[11px] text-slate-500 mt-1">{data.range}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-white/5"
            aria-label="Close preview"
          >
            <i className="ph ph-x text-lg" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="px-5 py-16 text-center text-slate-400 text-sm">
              <i className="ph ph-circle-notch animate-spin text-2xl block mb-2" />
              Loading preview…
            </div>
          )}

          {!loading && err && (
            <div className="px-5 py-10 text-center">
              <i className={`ph ${needsReauth ? 'ph-lock-key' : 'ph-warning-circle'} text-3xl block mb-2 ${needsReauth ? 'text-amber-300' : 'text-rose-300'}`} />
              <p className={`text-sm ${needsReauth ? 'text-amber-200' : 'text-rose-200'}`}>
                {needsReauth
                  ? 'You need re-auth or stronger permissions — open the Downloads Hub to continue.'
                  : err}
              </p>
            </div>
          )}

          {!loading && !err && data && (
            <>
              {/* KPIs */}
              {Array.isArray(data.kpis) && data.kpis.length > 0 && (
                <div className="px-5 py-3 border-b border-slate-800 grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {data.kpis.map((kpi, i) => {
                    const [label, value] = Array.isArray(kpi) ? kpi : [kpi?.label, kpi?.value];
                    return (
                      <div key={i} className="bg-slate-950/60 border border-slate-800 rounded-lg p-2">
                        <div className="text-[9px] uppercase tracking-wider text-slate-500 truncate">{label}</div>
                        <div className="text-sm font-semibold text-white mt-0.5 truncate" title={String(value ?? '')}>
                          {value ?? '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Notes */}
              {Array.isArray(data.notes) && data.notes.length > 0 && (
                <div className="px-5 pt-3 space-y-1">
                  {data.notes.map((n, i) => (
                    <div key={i} className="text-[11px] text-amber-300/80 flex items-start gap-1.5">
                      <i className="ph ph-info mt-0.5" /> <span>{n}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Sample table */}
              <div className="px-5 py-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-2">
                  {totalRows > 0
                    ? <>Showing first <span className="text-slate-300">{rows.length.toLocaleString()}</span> of <span className="text-slate-300">{totalRows.toLocaleString()}</span> rows</>
                    : 'No rows in the selected range.'}
                  {data.truncated && <span className="ml-2 text-amber-300">· truncated at server cap</span>}
                </div>

                {rows.length === 0 ? (
                  <div className="text-center py-10 text-slate-500 text-sm">
                    <i className="ph ph-tray text-3xl block mb-2" />
                    Nothing to preview yet.
                  </div>
                ) : (
                  <table className="w-full text-[11px] border-collapse">
                    <thead className="sticky top-0 bg-slate-900">
                      <tr>
                        {cols.map((c) => (
                          <th key={c} className="text-left font-semibold px-2 py-1.5 border-b border-slate-700 text-teal-300">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, ri) => (
                        <tr key={ri} className={ri % 2 ? 'bg-slate-950/40' : ''}>
                          {(Array.isArray(r) ? r : []).map((cell, ci) => (
                            <td key={ci} className="px-2 py-1.5 border-b border-slate-800/60 text-slate-300 align-top whitespace-nowrap">
                              {safeCell(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {showingMore && rows.length > 0 && (
                  <div className="text-[11px] text-slate-500 italic mt-3">
                    … {Math.max(0, totalRows - rows.length).toLocaleString()} more rows will be included in the actual download.
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-700 bg-slate-950/60 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-slate-500">
            Full exports — XLSX, PDF, CSV — live in the Downloads Hub.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 hover:bg-slate-800 rounded-lg"
            >
              Close
            </button>
            <button
              type="button"
              onClick={goToHub}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg text-white flex items-center gap-1.5 bg-teal-600 hover:bg-teal-500"
            >
              <i className="ph ph-arrow-square-out" /> Open in Downloads Hub
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
