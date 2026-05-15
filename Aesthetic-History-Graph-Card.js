/**
 * Aesthetic History Graph Card for Home Assistant Lovelace
 *
 * Multi-series time charts from recorder history with configurable styling,
 * thresholds, grid lines, and Jinja-templated options.
 *
 * Load as a module resource:
 *   - url: /local/Aesthetic-History-Graph-Card.js
 *     type: module
 */
import { html, css, LitElement, nothing } from 'https://cdn.jsdelivr.net/gh/lit/dist@2/core/lit-core.min.js';

const DEFAULT_COLORS = ['#93B5F2', '#F6B38A', '#D6D6D6', '#FFE08A', '#A8C9F0', '#A6D68A'];

function isTemplate(v) {
  return typeof v === 'string' && v.includes('{{') && v.includes('}}');
}

function isHardcodedNumber(v) {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== '' && !Number.isNaN(Number(s));
}

function getAtPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function parseDdHhMmToMs(str) {
  if (str == null || str === '') return null;
  const s = String(str).trim().toLowerCase();
  if (s === 'off') return null;
  const parts = s.split(':').map((p) => parseInt(String(p).trim(), 10));
  if (parts.length !== 3 || parts.some((x) => Number.isNaN(x) || x < 0)) return null;
  const [dd, hh, mm] = parts;
  if (hh > 23 || mm > 59) return null;
  return (((dd * 24 + hh) * 60 + mm) * 60 * 1000) >>> 0;
}

function parseNumericState(state) {
  if (state == null) return null;
  if (typeof state === 'number' && !Number.isNaN(state)) return state;
  const n = parseFloat(String(state).replace(/[^\d.-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

/** Recorder history/period response: `[[states…]]` or a flat state list. */
function historyStatesFromApi(data, entityId) {
  if (!Array.isArray(data) || !data.length) return [];
  if (Array.isArray(data[0])) {
    if (entityId && data.length > 1) {
      const match = data.find(
        (row) => Array.isArray(row) && row.length && String(row[0]?.entity_id) === String(entityId)
      );
      if (match) return match;
    }
    return data[0] || [];
  }
  if (data[0] && typeof data[0] === 'object' && data[0].entity_id) return data;
  return [];
}

function statesToPoints(states) {
  const pts = [];
  for (const st of states) {
    if (!st || st.state == null) continue;
    const t = new Date(st.last_changed || st.last_updated).getTime();
    const v = parseNumericState(st.state);
    if (v != null && !Number.isNaN(t)) pts.push({ t, v });
  }
  return pts;
}

/** Duplicate a lone point so a line can render. */
function ensureMinChartPoints(pts, min = 2) {
  if (pts.length >= min) return pts;
  if (pts.length === 1) {
    const p = pts[0];
    return [{ t: p.t - 60000, v: p.v }, p];
  }
  return pts;
}

/** YAML boolean or template string; `defaultVal` when unset or unknown. */
function resolveBool(raw, defaultVal) {
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).toLowerCase().trim();
  if (s === 'true' || s === 'yes' || s === 'on' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === 'off' || s === '0') return false;
  return defaultVal;
}

function partsInTimeZone(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const o = {};
  fmt.formatToParts(new Date(ms)).forEach((p) => {
    if (p.type !== 'literal') o[p.type] = +p.value;
  });
  return { y: o.year, m: o.month, d: o.day, h: o.hour, min: o.minute, s: o.second };
}

/** UTC ms for wall-clock y-m-d H:M:S in timeZone (search around UTC noon that calendar day). */
function utcMsForZonedWallClock(timeZone, y, m, d, H, M, S = 0) {
  const anchor = Date.UTC(y, m - 1, d, 12, 0, 0);
  for (let dh = -30; dh <= 30; dh += 1) {
    for (let dm = -120; dm <= 120; dm += 1) {
      for (let ds = -120; ds <= 120; ds += 1) {
        const g = anchor + (((dh * 60 + dm) * 60 + ds) * 1000) >>> 0;
        const p = partsInTimeZone(g, timeZone);
        if (p.y === y && p.m === m && p.d === d && p.h === H && p.min === M && p.s === S) return g;
      }
    }
  }
  return anchor;
}

function zonedMidnightContaining(ms, timeZone) {
  const p = partsInTimeZone(ms, timeZone);
  return utcMsForZonedWallClock(timeZone, p.y, p.m, p.d, 0, 0, 0);
}

/** Midnight-aligned tick times in [startMs, endMs] with periodMs step from successive midnights. */
function buildMidnightAlignedTimeTicks(startMs, endMs, periodMs, timeZone) {
  if (!periodMs || periodMs <= 0 || endMs <= startMs) return [];
  let t = zonedMidnightContaining(startMs, timeZone);
  while (t < startMs - periodMs) t += periodMs;
  while (t < startMs) t += periodMs;
  const out = [];
  for (; t <= endMs + 1; t += periodMs) {
    if (t >= startMs && t <= endMs) out.push(t);
  }
  return out;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  let h = hex.trim();
  if (h.startsWith('var(')) return null;
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  const x = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}`;
}

/** Lovelace editor: stroke colour when empty — `rgb_color` if present, else default palette (matches runtime). */
function editorSuggestColorForEntity(hassState, seriesIndex) {
  const rgb = hassState?.attributes?.rgb_color;
  if (Array.isArray(rgb) && rgb.length >= 3) {
    const [r, g, b] = rgb.map((x) => Number(x));
    if ([r, g, b].every((n) => Number.isFinite(n))) return rgbToHex(r, g, b);
  }
  return DEFAULT_COLORS[seriesIndex % DEFAULT_COLORS.length];
}

function lerpColor(c1, c2, t) {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  if (!a || !b) return c1;
  const u = clamp(t, 0, 1);
  return rgbToHex(a.r + (b.r - a.r) * u, a.g + (b.g - a.g) * u, a.b + (b.b - a.b) * u);
}

function sortThresholds(rows) {
  if (!Array.isArray(rows)) return [];
  return [...rows]
    .filter((r) => r && r.color != null)
    .map((r) => ({ value: Number(r.value), color: String(r.color).trim() }))
    .filter((r) => !Number.isNaN(r.value))
    .sort((a, b) => a.value - b.value);
}

/** smoothBand 0..10 → half-width in "value units" for soft threshold edges. */
function thresholdSmoothHalfWidth(valueSpan, smooth10) {
  const s = clamp(Number(smooth10) || 0, 0, 10);
  if (s <= 0 || !valueSpan || valueSpan <= 0) return 0;
  return (valueSpan * s) / 100;
}

function valueGradientStopList(thresholds, baseColor, vmin, vmax, thrSmooth) {
  const span = vmax - vmin || 1;
  const anchors = new Set([vmin, vmax, ...thresholds.map((t) => t.value)]);
  const sorted = [...anchors].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.map((v) => ({
    off: clamp(((vmax - v) / span) * 100, 0, 100),
    color: colorAtValue(thresholds, baseColor, v, thrSmooth, vmin, vmax),
  }));
}

function colorAtValue(sorted, baseColor, v, smooth10, yMin, yMax) {
  const span = Math.max(1e-9, yMax - yMin);
  const half = thresholdSmoothHalfWidth(span, smooth10);
  if (!sorted.length) return baseColor;
  let i = 0;
  while (i < sorted.length && sorted[i].value <= v) i += 1;
  if (i === 0) {
    const t0 = sorted[0];
    const dist = t0.value - v;
    if (half > 0 && dist > 0 && dist < half) return lerpColor(baseColor, t0.color, 1 - dist / half);
    return baseColor;
  }
  const lower = sorted[i - 1];
  const upper = sorted[i];
  if (!upper) return lower.color;
  const mid = (lower.value + upper.value) / 2;
  const w = half + 1e-9;
  if (v < mid) {
    const u = clamp((v - (lower.value - w)) / (2 * w), 0, 1);
    return lerpColor(i >= 2 ? sorted[i - 2].color : baseColor, lower.color, u);
  }
  const u2 = clamp((v - (mid - w)) / (2 * w), 0, 1);
  return lerpColor(lower.color, upper.color, u2);
}

/** Catmull-Rom to cubic Bezier; tension from smoothing 0..10. */
function smoothPointsToPathD(points, smooth10) {
  const s = clamp(Number(smooth10) || 0, 0, 10);
  if (points.length < 2) return '';
  if (s < 0.5) {
    return (
      'M ' +
      points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L ') +
      ''
    );
  }
  const t = 0.15 + (s / 10) * 2.5;
  const p = points;
  let d = `M ${p[0].x.toFixed(2)},${p[0].y.toFixed(2)}`;
  for (let i = 0; i < p.length - 1; i += 1) {
    const p0 = p[i === 0 ? i : i - 1];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2 < p.length ? i + 2 : i + 1];
    const c1x = p1.x + ((p2.x - p0.x) / 6) * t;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * t;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * t;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * t;
    d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

function normalizeFillMode(raw) {
  if (raw === true || raw === 'true') return 'solid';
  if (raw === false || raw === 'false' || raw == null || raw === '') return 'none';
  const s = String(raw).trim().toLowerCase().replace(/ /g, '_');
  if (s === 'true') return 'solid';
  if (s === 'false' || s === 'none') return 'none';
  if (['gradient_up', 'gradient_down', 'gradient_left', 'gradient_right', 'solid'].includes(s)) return s === 'solid' ? 'solid' : s;
  return 'none';
}

/** Editor “On” when stored value is non-empty and not case-insensitive `off`. */
function editorStoredOptionOn(raw) {
  const s = raw == null ? '' : String(raw).trim().toLowerCase();
  return s !== '' && s !== 'off';
}

/** Hex `#rgb` / `#rrggbb` / `#rrggbbaa` → CSS colour for preview swatch; `var()` etc. → empty. */
function editorColorSwatchBackground(str) {
  const s = str == null ? '' : String(str).trim();
  if (!s) return '';
  if (/^#[0-9A-Fa-f]{8}$/i.test(s)) return s;
  if (/^#[0-9A-Fa-f]{6}$/i.test(s)) return s;
  if (/^#[0-9A-Fa-f]{3}$/i.test(s)) {
    const h = s.slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  return '';
}

/** `#rrggbb` for `<input type="color">`; supports shorthand `#rgb`. Omit `#rrggbbaa` (alpha). */
function editorHex6ForColorInput(str) {
  const s = str == null ? '' : String(str).trim();
  if (/^#[0-9A-Fa-f]{6}$/i.test(s)) return `#${s.slice(1).toLowerCase()}`;
  if (/^#[0-9A-Fa-f]{3}$/i.test(s)) {
    const h = s.slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  return null;
}

function collectTemplatesDeep(cfg, prefix = '') {
  const out = {};
  if (!cfg || typeof cfg !== 'object') return out;
  const keys = Array.isArray(cfg) ? cfg.map((_, i) => String(i)) : Object.keys(cfg);
  for (const k of keys) {
    const v = cfg[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (isTemplate(v)) {
      out[path] = v;
    } else if (k === 'entities' && Array.isArray(v)) {
      v.forEach((ent, i) => {
        Object.assign(out, collectTemplatesDeep(ent, `entities.${i}`));
        if (ent && Array.isArray(ent.color_threshold)) {
          ent.color_threshold.forEach((row, j) => {
            if (row && typeof row === 'object') Object.assign(out, collectTemplatesDeep(row, `entities.${i}.color_threshold.${j}`));
          });
        }
      });
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, collectTemplatesDeep(v, path));
    }
  }
  return out;
}

/** Lovelace card: fetches recorder history and renders an SVG time-series chart. */
class AestheticHistoryGraphCard extends LitElement {
  static properties = {
    hass: { type: Object, attribute: false },
    _config: { type: Object, state: true },
    _templateResults: { type: Object, state: true },
    _historyByEntity: { type: Object, state: true },
    _historyLoading: { type: Boolean, state: true },
    _historyError: { type: String, state: true },
    _chartWidth: { type: Number, state: true },
    _chartHeight: { type: Number, state: true },
  };

  constructor() {
    super();
    this.hass = null;
    this._config = null;
    this._templateResults = {};
    this._templateUnsubscribes = {};
    this._historyByEntity = {};
    this._historyLoading = false;
    this._historyError = '';
    this._chartWidth = 400;
    this._chartHeight = 200;
    this._resizeObserver = null;
    this._fetchTimer = null;
    this._chartRootEl = null;
  }

  static getConfigElement() {
    return document.createElement('aesthetic-history-graph-card-editor');
  }

  static getStubConfig() {
    return {
      type: 'custom:aesthetic-history-graph-card',
      alignment: 'left',
      entities: [],
      legend_position: 'bottom',
      show_legend: true,
      show_state: true,
      show_title: true,
      show_unit: false,
      unit_source: 'automatic',
      smoothing: 0,
      time_lines: 'off',
      time_range: '07:00:00',
      title_position: 'top',
      value_lines: 'off',
    };
  }

  _legendShowsState(row) {
    const idx = row._cfgIdx;
    const cardRaw = this._resolve('show_state');
    const cardVal = resolveBool(cardRaw, true);
    const perRaw = this._resolve(`entities.${idx}.show_state`);
    if (perRaw !== undefined && perRaw !== null && perRaw !== '') {
      return resolveBool(perRaw, cardVal);
    }
    return cardVal;
  }

  _legendShowsUnit() {
    const showLegend = this._resolve('show_legend') !== false;
    if (!showLegend) return false;
    if (!resolveBool(this._resolve('show_state'), true)) return false;
    return resolveBool(this._resolve('show_unit'), false);
  }

  _getDisplayUnitForRow(row) {
    const source = this._resolve('unit_source') ?? 'automatic';
    if (source === 'custom') {
      const u = this._resolve('unit_custom');
      return u != null && String(u).trim() !== '' ? String(u).trim() : '';
    }
    const id = row._entityId;
    if (!id || isTemplate(id) || isHardcodedNumber(id)) return '';
    const st = this.hass?.states?.[id];
    const u = st?.attributes?.unit_of_measurement;
    return u != null && String(u).trim() !== '' ? String(u).trim() : '';
  }

  /** Legend swatch corner radius (px); chart SVG unchanged. */
  _resolvedLegendSwatchRadiusPx() {
    const raw = this._resolve('legend_radius');
    if (raw == null || raw === '') return 3;
    const n = parseFloat(String(raw).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) return 3;
    return clamp(Math.round(n), 0, 24);
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid config');
    const entities = Array.isArray(config.entities) ? config.entities : [];
    this._config = { ...config, entities };
  }

  connectedCallback() {
    super.connectedCallback();
    this.updateComplete.then(() => this._attachResizeObserver());
  }

  disconnectedCallback() {
    Object.values(this._templateUnsubscribes).forEach((fn) => {
      try {
        fn();
      } catch (_) {}
    });
    this._templateUnsubscribes = {};
    this._templateResults = {};
    if (this._resizeObserver && this._chartRootEl) {
      try {
        this._resizeObserver.unobserve(this._chartRootEl);
      } catch (_) {}
    }
    this._resizeObserver = null;
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    this._fetchTimer = null;
    super.disconnectedCallback();
  }

  _attachResizeObserver() {
    const el = this.renderRoot?.querySelector?.('.chart-surface');
    if (!el || typeof ResizeObserver === 'undefined') return;
    this._chartRootEl = el;
    if (this._resizeObserver) {
      try {
        this._resizeObserver.disconnect();
      } catch (_) {}
    }
    this._resizeObserver = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      const w = Math.max(80, Math.floor(cr.width));
      const h = Math.max(60, Math.floor(cr.height));
      if (w !== this._chartWidth || h !== this._chartHeight) {
        this._chartWidth = w;
        this._chartHeight = h;
      }
    });
    this._resizeObserver.observe(el);
  }

  willUpdate(changed) {
    if (changed.has('hass') || changed.has('_config')) {
      this._updateTemplateSubscriptions();
    }
    if (changed.has('hass') || changed.has('_config') || changed.has('_templateResults')) {
      this._scheduleHistoryFetch();
    }
  }

  updated(changed) {
    if (changed.has('_config') && !this._resizeObserver) {
      this.updateComplete.then(() => this._attachResizeObserver());
    }
  }

  _resolve(path, fallback = undefined) {
    const raw = getAtPath(this._config, path);
    if (isTemplate(raw)) {
      const res = this._templateResults[path];
      return res !== undefined ? res : fallback;
    }
    return raw !== undefined ? raw : fallback;
  }

  async _updateTemplateSubscriptions() {
    const cfg = this._config;
    const hass = this.hass;
    if (!hass?.connection || !cfg) return;

    const templates = collectTemplatesDeep(cfg);

    Object.keys(this._templateUnsubscribes).forEach((key) => {
      if (!(key in templates)) {
        try {
          this._templateUnsubscribes[key]();
        } catch (_) {}
        delete this._templateUnsubscribes[key];
        delete this._templateResults[key];
      }
    });

    for (const [path, template] of Object.entries(templates)) {
      if (this._templateUnsubscribes[path]) continue;
      const entityIds = [];
      const seen = new Set();
      (cfg.entities || []).forEach((e) => {
        if (e?.entity && !isTemplate(e.entity) && !seen.has(e.entity)) {
          seen.add(e.entity);
          entityIds.push(e.entity);
        }
      });
      try {
        let templateStr = String(template).trim();
        if (
          (templateStr.startsWith('"') && templateStr.endsWith('"')) ||
          (templateStr.startsWith("'") && templateStr.endsWith("'"))
        ) {
          templateStr = templateStr.slice(1, -1).trim();
        }
        const unsub = await hass.connection.subscribeMessage(
          (msg) => {
            this._templateResults = { ...this._templateResults, [path]: msg.result };
            this.requestUpdate();
          },
          { type: 'render_template', template: templateStr, entity_ids: entityIds }
        );
        this._templateUnsubscribes[path] = unsub;
      } catch (_) {}
    }
  }

  _scheduleHistoryFetch() {
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    this._fetchTimer = setTimeout(() => this._fetchHistory(), 280);
  }

  _resolvedEntityRows() {
    const cfg = this._config;
    const hass = this.hass;
    if (!cfg?.entities?.length || !hass) return [];
    return cfg.entities.map((ent, cfgIdx) => {
      if (!ent) return null;
      if (typeof ent === 'string') {
        const id = ent.trim();
        if (!id) return null;
        return { entity: id, _entityId: id, _cfgIdx: cfgIdx };
      }
      const rawEntity = ent.entity;
      if (isTemplate(rawEntity)) {
        const resolved = this._templateResults[`entities.${cfgIdx}.entity`];
        if (resolved == null || String(resolved).trim() === '') return null;
        return { ...ent, _entityId: String(resolved).trim(), _cfgIdx: cfgIdx };
      }
      if (!rawEntity) return null;
      return { ...ent, _entityId: String(rawEntity).trim(), _cfgIdx: cfgIdx };
    }).filter(Boolean);
  }

  async _fetchHistory() {
    const hass = this.hass;
    const cfg = this._config;
    if (!hass?.callApi || !cfg) return;

    const durationMs = parseDdHhMmToMs(this._resolve('time_range') ?? '07:00:00');
    if (!durationMs) {
      this._historyError = 'Invalid time_range';
      this._historyByEntity = {};
      return;
    }

    const rows = this._resolvedEntityRows();
    if (!rows.length) {
      this._historyByEntity = {};
      this._historyError = '';
      return;
    }

    const end = Date.now();
    const start = end - durationMs;
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();

    this._historyLoading = true;
    this._historyError = '';
    this.requestUpdate();

    const next = {};
    try {
      await Promise.all(
        rows.map(async (row) => {
          const id = row._entityId;
          try {
            const url =
              `history/period/${startIso}?filter_entity_id=${encodeURIComponent(id)}` +
              `&end_time=${encodeURIComponent(endIso)}&minimal_response&no_attributes`;
            const data = await hass.callApi('GET', url);
            next[id] = statesToPoints(historyStatesFromApi(data, id));
          } catch (e) {
            next[id] = [];
          }
        })
      );
      this._historyByEntity = next;
      this._historyError = '';
    } catch (e) {
      this._historyError = e?.message || String(e);
      this._historyByEntity = {};
    } finally {
      this._historyLoading = false;
      this.requestUpdate();
    }
  }

  _plotMetrics() {
    const margin = { top: 8, right: 12, bottom: 28, left: 44 };
    const W = this._chartWidth;
    const H = this._chartHeight;
    const innerW = Math.max(10, W - margin.left - margin.right);
    const innerH = Math.max(10, H - margin.top - margin.bottom);
    return { margin, innerW, innerH, W, H };
  }

  _valueDomain() {
    const rows = this._resolvedEntityRows();
    const hist = this._historyByEntity;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const row of rows) {
      const pts = hist[row._entityId] || [];
      for (const p of pts) {
        vmin = Math.min(vmin, p.v);
        vmax = Math.max(vmax, p.v);
      }
    }
    if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) {
      return { vmin: 0, vmax: 1 };
    }
    if (vmin === vmax) {
      vmin -= 1;
      vmax += 1;
    }
    const pad = (vmax - vmin) * 0.06;
    return { vmin: vmin - pad, vmax: vmax + pad };
  }

  _timeDomain() {
    const durationMs = parseDdHhMmToMs(this._resolve('time_range') ?? '07:00:00') || 7 * 24 * 3600 * 1000;
    const end = Date.now();
    const start = end - durationMs;
    return { tmin: start, tmax: end };
  }

  _renderEmpty() {
    return html`
      <div class="card-content empty">
        <span class="empty-text">No data</span>
      </div>
    `;
  }

  _hasChartableHistory(rows, tmin, tmax) {
    if (!rows?.length) return false;
    const hist = this._historyByEntity || {};
    return rows.some((row) => {
      const pts = (hist[row._entityId] || []).filter((p) => p.t >= tmin && p.t <= tmax);
      return pts.length >= 1;
    });
  }

  _shouldShowEmpty(rows) {
    if (!this.hass || !rows.length) return true;
    if (!parseDdHhMmToMs(this._resolve('time_range') ?? '07:00:00')) return true;
    const { tmin, tmax } = this._timeDomain();
    return !this._hasChartableHistory(rows, tmin, tmax);
  }

  render() {
    if (!this._config) return nothing;
    if (!this.hass) {
      return html`
        <ha-card>
          <div class="card-content empty">
            <span class="empty-text">Aesthetic History Graph Card</span>
          </div>
        </ha-card>
      `;
    }
    return html`<ha-card>${this._renderCardInner()}</ha-card>`;
  }

  _renderCardInner() {
    const rows = this._resolvedEntityRows();
    if (this._shouldShowEmpty(rows)) {
      return this._renderEmpty();
    }
    const showTitle = this._resolve('show_title') !== false;
    const titleVal = this._resolve('title');
    const hasTitle = showTitle && titleVal != null && String(titleVal) !== '';
    const alignment = this._resolve('alignment') ?? 'left';
    const legendPos = this._resolve('legend_position') || 'bottom';
    const showLegend = this._resolve('show_legend') !== false;

    const legendEl = showLegend && rows.length ? this._renderLegend(rows, alignment) : nothing;

    const titleEl = hasTitle
      ? html`<div class="card-title" style="text-align:${alignment}">${titleVal}</div>`
      : nothing;

    const titlePos = this._resolve('title_position') || 'top';
    const topParts = [];
    const bottomParts = [];
    if (titlePos === 'top' && hasTitle) topParts.push(titleEl);
    if (legendPos === 'top' && showLegend && rows.length) topParts.push(legendEl);
    if (legendPos === 'bottom' && showLegend && rows.length) bottomParts.push(legendEl);
    if (titlePos === 'bottom' && hasTitle) bottomParts.push(titleEl);

    const chartBlock = this._renderChartBlock(rows);

    return html`
      <div class="card-content">
        <div class="card-inner">
          ${topParts.length ? html`<div class="top">${topParts}</div>` : nothing}
          ${chartBlock}
          ${bottomParts.length ? html`<div class="bottom">${bottomParts}</div>` : nothing}
        </div>
      </div>
    `;
  }

  _renderLegend(rows, alignment) {
    const hist = this._historyByEntity;
    const justify =
      alignment === 'center' ? 'center' : alignment === 'right' ? 'flex-end' : 'flex-start';
    const swatchRadiusPx = this._resolvedLegendSwatchRadiusPx();
    return html`
      <div class="legend" style="justify-content:${justify}">
        ${rows.map((row, i) => {
          const id = row._entityId;
          const pts = hist[id] || [];
          const last = pts.length ? pts[pts.length - 1].v : null;
          const name =
            this._resolve(`entities.${row._cfgIdx}.name`) ||
            this.hass?.states?.[id]?.attributes?.friendly_name ||
            id;
          const color =
            this._resolve(`entities.${row._cfgIdx}.color`) || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
          const valStr = last != null ? String(Math.round(last * 1000) / 1000) : '—';
          const showState = this._legendShowsState(row);
          const showUnit = this._legendShowsUnit();
          const unitStr = showUnit ? this._getDisplayUnitForRow(row) : '';
          let text = name;
          if (showState) {
            text = `${name}: ${valStr}`;
            if (showUnit && unitStr) text += ` ${unitStr}`;
          } else if (showUnit && unitStr) {
            text = `${name} ${unitStr}`;
          }
          return html`
            <div class="legend-item">
              <span class="legend-swatch" style="background:${color};border-radius:${swatchRadiusPx}px"></span>
              <span class="legend-label">${text}</span>
            </div>
          `;
        })}
      </div>
    `;
  }

  _renderChartBlock(rows) {
    if (this._historyError) {
      return html`<div class="card-content empty"><span class="empty-text">${this._historyError}</span></div>`;
    }
    const { margin, innerW, innerH, W, H } = this._plotMetrics();
    const { vmin, vmax } = this._valueDomain();
    const { tmin, tmax } = this._timeDomain();
    const tz = this.hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    const timeLinesRaw = this._resolve('time_lines') ?? 'off';
    const periodMs =
      String(timeLinesRaw).toLowerCase().trim() === 'off' ? null : parseDdHhMmToMs(timeLinesRaw);
    const timeTicks = periodMs ? buildMidnightAlignedTimeTicks(tmin, tmax, periodMs, tz) : [];

    const valueLinesRaw = this._resolve('value_lines') ?? 'off';
    const vInterval =
      String(valueLinesRaw).toLowerCase().trim() === 'off' ? null : parseFloat(valueLinesRaw);
    const valueTicks = [];
    if (vInterval && vInterval > 0 && Number.isFinite(vmin) && Number.isFinite(vmax)) {
      const k0 = Math.floor(vmin / vInterval);
      const k1 = Math.ceil(vmax / vInterval);
      for (let k = k0; k <= k1; k += 1) valueTicks.push(k * vInterval);
    }

    const smoothing = clamp(parseFloat(this._resolve('smoothing') ?? 0) || 0, 0, 10);

    const xScale = (t) => margin.left + ((t - tmin) / (tmax - tmin)) * innerW;
    const yScale = (v) => margin.top + (1 - (v - vmin) / (vmax - vmin)) * innerH;

    const fmtTime = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
    });

    const gridV = timeTicks.map((tk) => {
      const x = xScale(tk);
      return html`<line class="grid-line" x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + innerH}" />`;
    });

    const gridH = valueTicks.map((vk) => {
      const y = yScale(vk);
      return html`<line class="grid-line" x1="${margin.left}" y1="${y}" x2="${margin.left + innerW}" y2="${y}" />`;
    });

    const defs = [];
    const fillPaths = [];
    const linePaths = [];
    let gid = 0;

    rows.forEach((row, seriesIdx) => {
      const idx = row._cfgIdx;
      const id = row._entityId;
      let pts = (this._historyByEntity[id] || []).filter((p) => p.t >= tmin && p.t <= tmax);
      pts = ensureMinChartPoints(pts);
      if (pts.length < 2) return;

      const baseColor =
        this._resolve(`entities.${idx}.color`) || DEFAULT_COLORS[seriesIdx % DEFAULT_COLORS.length];
      const lineWidth = parseFloat(this._resolve(`entities.${idx}.line_width`) ?? 2) || 2;
      const fillMode = normalizeFillMode(this._resolve(`entities.${idx}.fill`));
      const fillOpacity = clamp(parseFloat(this._resolve(`entities.${idx}.fill_opacity`) ?? 40), 0, 100) / 100;
      const thrRaw = this._resolve(`entities.${idx}.color_threshold`);
      const thresholds = sortThresholds(Array.isArray(thrRaw) ? thrRaw : []);
      const thrSmooth = clamp(parseFloat(this._resolve(`entities.${idx}.color_threshold_smoothing`) ?? 0), 0, 10);

      const xy = pts.map((p) => ({ x: xScale(p.t), y: yScale(p.v), t: p.t, v: p.v }));
      const dLine = smoothPointsToPathD(xy, smoothing);
      const yBase = margin.top + innerH;
      const dFill = `${dLine} L ${xy[xy.length - 1].x.toFixed(2)},${yBase.toFixed(2)} L ${xy[0].x.toFixed(2)},${yBase.toFixed(2)} Z`;

      if (fillMode !== 'none') {
        const fillId = `hgf-${idx}-${seriesIdx}-${gid++}`;
        let fillAttr = '';
        let fillOpAttr = null;
        let maskAttr = '';

        const directional =
          thresholds.length &&
          ['gradient_up', 'gradient_down', 'gradient_left', 'gradient_right'].includes(fillMode);

        if (thresholds.length) {
          const y1 = margin.top;
          const y2 = yBase;
          const stops = valueGradientStopList(thresholds, baseColor, vmin, vmax, thrSmooth);
          const stopEls = stops.map(
            (s) =>
              html`<stop offset="${s.off}%" stop-color="${s.color}" stop-opacity="${fillOpacity}" />`
          );
          defs.push(html`
            <linearGradient id="${fillId}" gradientUnits="userSpaceOnUse" x1="${margin.left}" y1="${y1}" x2="${margin.left}" y2="${y2}">
              ${stopEls}
            </linearGradient>
          `);
          fillAttr = `url(#${fillId})`;
          fillOpAttr = null;

          if (directional) {
            const maskId = `hgm-${idx}-${seriesIdx}-${gid++}`;
            let mx1 = 0,
              my1 = 0,
              mx2 = 0,
              my2 = 1;
            if (fillMode === 'gradient_down') {
              mx1 = 0;
              my1 = 0;
              mx2 = 0;
              my2 = 1;
            } else if (fillMode === 'gradient_up') {
              mx1 = 0;
              my1 = 1;
              mx2 = 0;
              my2 = 0;
            } else if (fillMode === 'gradient_right') {
              mx1 = 0;
              my1 = 0;
              mx2 = 1;
              my2 = 0;
            } else if (fillMode === 'gradient_left') {
              mx1 = 1;
              my1 = 0;
              mx2 = 0;
              my2 = 0;
            }
            const maskGradId = `${maskId}-g`;
            defs.push(html`
              <linearGradient id="${maskGradId}" gradientUnits="objectBoundingBox" x1="${mx1}" y1="${my1}" x2="${mx2}" y2="${my2}">
                <stop offset="0%" stop-color="white" stop-opacity="1" />
                <stop offset="100%" stop-color="white" stop-opacity="0" />
              </linearGradient>
              <mask id="${maskId}" maskUnits="objectBoundingBox" maskContentUnits="objectBoundingBox">
                <rect x="0" y="0" width="1" height="1" fill="url(#${maskGradId})" />
              </mask>
            `);
            maskAttr = `url(#${maskId})`;
          }
        } else if (fillMode === 'solid') {
          fillAttr = baseColor;
          fillOpAttr = fillOpacity;
        } else if (['gradient_up', 'gradient_down', 'gradient_left', 'gradient_right'].includes(fillMode)) {
          let x1 = margin.left,
            y1 = margin.top,
            x2 = margin.left,
            y2 = yBase;
          if (fillMode === 'gradient_up') {
            x1 = margin.left;
            y1 = yBase;
            x2 = margin.left;
            y2 = margin.top;
          } else if (fillMode === 'gradient_down') {
            x1 = margin.left;
            y1 = margin.top;
            x2 = margin.left;
            y2 = yBase;
          } else if (fillMode === 'gradient_left') {
            x1 = margin.left + innerW;
            y1 = margin.top;
            x2 = margin.left;
            y2 = margin.top;
          } else if (fillMode === 'gradient_right') {
            x1 = margin.left;
            y1 = margin.top;
            x2 = margin.left + innerW;
            y2 = margin.top;
          }
          defs.push(html`
            <linearGradient id="${fillId}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
              <stop offset="0%" stop-color="${baseColor}" stop-opacity="${fillOpacity}" />
              <stop offset="100%" stop-color="${baseColor}" stop-opacity="0" />
            </linearGradient>
          `);
          fillAttr = `url(#${fillId})`;
        }

        if (fillAttr) {
          fillPaths.push(
            maskAttr
              ? html`
              <path
                class="area-path"
                d="${dFill}"
                fill="${fillAttr}"
                fill-opacity="${fillOpAttr != null ? fillOpAttr : 1}"
                stroke="none"
                mask="${maskAttr}"
              />
            `
              : html`
              <path
                class="area-path"
                d="${dFill}"
                fill="${fillAttr}"
                fill-opacity="${fillOpAttr != null ? fillOpAttr : 1}"
                stroke="none"
              />
            `
          );
        }
      }

      if (thresholds.length) {
        let seg = [];
        let lastC = '';
        for (let i = 0; i < xy.length; i += 1) {
          const c = colorAtValue(thresholds, baseColor, pts[i].v, thrSmooth, vmin, vmax);
          if (i === 0) {
            seg = [xy[i]];
            lastC = c;
            continue;
          }
          if (c !== lastC && seg.length) {
            const d = smoothPointsToPathD(seg, smoothing);
            linePaths.push(html`<path class="line-path" vector-effect="non-scaling-stroke" d="${d}" fill="none" stroke="${lastC}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round" />`);
            seg = [xy[i - 1], xy[i]];
            lastC = c;
          } else {
            seg.push(xy[i]);
          }
        }
        if (seg.length) {
          const d = smoothPointsToPathD(seg, smoothing);
          linePaths.push(html`<path class="line-path" vector-effect="non-scaling-stroke" d="${d}" fill="none" stroke="${lastC}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round" />`);
        }
      } else {
        linePaths.push(html`
          <path
            class="line-path"
            vector-effect="non-scaling-stroke"
            d="${dLine}"
            fill="none"
            stroke="${baseColor}"
            stroke-width="${lineWidth}"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        `);
      }
    });

    const xLabels = timeTicks
      .filter((_, i) => i % Math.max(1, Math.ceil(timeTicks.length / 10)) === 0 || timeTicks.length <= 12)
      .map((tk) => {
        const x = xScale(tk);
        return html`<text class="axis-text" x="${x}" y="${H - 6}" text-anchor="middle">${fmtTime.format(tk)}</text>`;
      });

    const yLabels = valueTicks
      .filter((_, i) => i % Math.max(1, Math.ceil(valueTicks.length / 8)) === 0 || valueTicks.length <= 10)
      .map((vk) => {
        const y = yScale(vk);
        return html`<text class="axis-text" x="${margin.left - 6}" y="${y + 4}" text-anchor="end">${String(Math.round(vk * 100) / 100)}</text>`;
      });

    return html`
      <div class="chart-wrap">
        <div class="chart-surface" style="min-height:200px">
          <svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
            <defs>${defs}</defs>
            <rect x="${margin.left}" y="${margin.top}" width="${innerW}" height="${innerH}" class="plot-bg" rx="4" />
            ${gridV}
            ${gridH}
            ${fillPaths}
            ${linePaths}
            ${xLabels}
            ${yLabels}
          </svg>
        </div>
      </div>
    `;
  }

  static styles = css`
    ha-card {
      background: var(--ha-card-background, var(--card-background-color, var(--sidebar-background-color)));
      border-radius: var(--ha-card-border-radius, 12px);
      overflow: hidden;
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .card-content {
      padding: 12px 16px;
      color: var(--primary-text-color);
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      align-items: stretch;
    }
    .card-content:not(.empty) {
      justify-content: center;
    }
    .card-inner {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      align-items: stretch;
      justify-content: center;
      width: 100%;
    }
    .card-content.empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 60px;
      flex: 1;
    }
    .empty-text {
      color: var(--secondary-text-color);
      font-size: 14px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 8px;
      color: var(--primary-text-color);
    }
    .top {
      margin-bottom: 12px;
      flex-shrink: 0;
      width: 100%;
    }
    .bottom {
      margin-top: 12px;
      flex-shrink: 0;
      width: 100%;
    }
    .chart-wrap {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
    }
    .chart-surface {
      flex: 1 1 auto;
      min-height: 160px;
      width: 100%;
      position: relative;
    }
    .chart-surface svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .plot-bg {
      fill: rgba(var(--rgb-primary-text-color, 0, 0, 0), 0.04);
    }
    .grid-line {
      stroke: var(--divider-color, rgba(127, 127, 127, 0.35));
      stroke-width: 1;
      stroke-dasharray: 3 3;
    }
    .axis-text {
      fill: var(--secondary-text-color);
      font-size: 10px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 16px;
      font-size: 12px;
      color: var(--secondary-text-color);
      width: 100%;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .legend-swatch {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .legend-label {
      color: var(--primary-text-color);
    }
  `;
}

if (!customElements.get('aesthetic-history-graph-card')) {
  customElements.define('aesthetic-history-graph-card', AestheticHistoryGraphCard);
}

/** Lovelace visual editor for Aesthetic History Graph Card. */
class AestheticHistoryGraphCardEditor extends LitElement {
  static properties = {
    hass: { type: Object, attribute: false },
    lovelace: { type: Object, attribute: false },
    _config: { type: Object, state: true },
    _expandedEntities: { type: Object, state: true },
  };

  constructor() {
    super();
    this.hass = null;
    this.lovelace = null;
    this._config = {};
    this._expandedEntities = {};
    this._entitiesSig = undefined;
  }

  setConfig(config) {
    this._config = config || {};
    if (!Array.isArray(this._config.entities)) this._config.entities = [];
    const sig = JSON.stringify(
      (this._config.entities || []).map((e) =>
        e && typeof e === 'object' ? String(e.entity ?? '').trim() : ''
      )
    );
    const changedList = sig !== this._entitiesSig;
    this._entitiesSig = sig;
    if (changedList) {
      queueMicrotask(() => this._maybeBackfillEntityDefaults());
    }
  }

  updated(changed) {
    super.updated(changed);
    if (!changed.has('hass')) return;
    const prevHass = changed.get('hass');
    if (prevHass || !this.hass?.states) return;
    queueMicrotask(() => this._maybeBackfillEntityDefaults());
  }

  /** When HA state becomes available, fill empty name/colour for plain entity IDs (no templates). */
  _maybeBackfillEntityDefaults() {
    const hass = this.hass;
    if (!hass?.states) return;
    const list = this._config.entities;
    if (!Array.isArray(list) || !list.length) return;
    let touched = false;
    const entities = list.map((ent, i) => {
      if (!ent || typeof ent !== 'object') return ent;
      const raw = ent.entity;
      if (raw == null || String(raw).trim() === '' || isTemplate(raw)) return ent;
      const id = String(raw).trim();
      const st = hass.states[id];
      if (!st) return ent;
      const nameEmpty = ent.name == null || String(ent.name).trim() === '';
      const colorEmpty = ent.color == null || String(ent.color).trim() === '';
      if (!nameEmpty && !colorEmpty) return ent;
      const row = { ...ent };
      if (nameEmpty) {
        const fn = st.attributes?.friendly_name;
        row.name = fn != null && String(fn).trim() !== '' ? String(fn).trim() : id;
        touched = true;
      }
      if (colorEmpty) {
        row.color = editorSuggestColorForEntity(st, i);
        touched = true;
      }
      return row;
    });
    if (!touched) return;
    const cfg = { ...this._config, entities };
    this._config = cfg;
    this.configChanged(cfg);
  }

  configChanged(newConfig) {
    this.dispatchEvent(
      new CustomEvent('config-changed', {
        bubbles: true,
        composed: true,
        detail: { config: newConfig },
      })
    );
  }

  _valueChanged(field, value) {
    const cfg = { ...this._config };
    if (value === '' || value === null || value === undefined) delete cfg[field];
    else cfg[field] = value;
    this._config = cfg;
    this.configChanged(cfg);
  }

  _entityChanged(index, field, value) {
    const entities = [...(this._config.entities || [])];
    if (!entities[index]) entities[index] = { entity: '' };
    if (value === '' || value === null || value === undefined) delete entities[index][field];
    else entities[index][field] = value;

    if (field === 'entity' && value !== '') {
      const trimmed = String(value).trim();
      const hass = this.hass;
      if (hass?.states && trimmed && !isTemplate(trimmed)) {
        const st = hass.states[trimmed];
        if (st) {
          const row = { ...entities[index] };
          const nameEmpty = row.name == null || String(row.name).trim() === '';
          const colorEmpty = row.color == null || String(row.color).trim() === '';
          if (nameEmpty) {
            const fn = st.attributes?.friendly_name;
            row.name = fn != null && String(fn).trim() !== '' ? String(fn).trim() : trimmed;
          }
          if (colorEmpty) {
            row.color = editorSuggestColorForEntity(st, index);
          }
          entities[index] = row;
        }
      }
    }

    if (field === 'entity' && value === '') entities.splice(index, 1);
    this._valueChanged('entities', entities);
  }

  _thresholdChanged(ei, ti, field, value) {
    const entities = [...(this._config.entities || [])];
    const ent = { ...(entities[ei] || {}) };
    const th = [...(ent.color_threshold || [])];
    if (!th[ti]) th[ti] = { value: 0, color: '#fff' };
    th[ti] = { ...th[ti], [field]: value };
    ent.color_threshold = th;
    entities[ei] = ent;
    this._valueChanged('entities', entities);
  }

  _addThreshold(ei) {
    const entities = [...(this._config.entities || [])];
    const ent = { ...(entities[ei] || {}) };
    ent.color_threshold = [...(ent.color_threshold || []), { value: 0, color: '#FFD54F' }];
    entities[ei] = ent;
    this._valueChanged('entities', entities);
  }

  _removeThreshold(ei, ti) {
    const entities = [...(this._config.entities || [])];
    const ent = { ...(entities[ei] || {}) };
    const th = [...(ent.color_threshold || [])];
    th.splice(ti, 1);
    if (th.length) ent.color_threshold = th;
    else delete ent.color_threshold;
    entities[ei] = ent;
    this._valueChanged('entities', entities);
  }

  _toggleEntityExpand(i) {
    const ent = this._config.entities?.[i];
    const cur = this._expandedEntities[i] ?? isTemplate(ent?.entity);
    this._expandedEntities = { ...this._expandedEntities, [i]: !cur };
  }

  _addEntity() {
    this._valueChanged('entities', [...(this._config.entities || []), { entity: '' }]);
  }

  _removeEntity(i) {
    const entities = [...(this._config.entities || [])];
    entities.splice(i, 1);
    this._valueChanged('entities', entities);
  }

  _getEntityOptions() {
    if (!this.hass?.states) return [];
    return Object.keys(this.hass.states).sort();
  }

  render() {
    const c = this._config;
    const entities = c.entities || [];
    const entityOptions = this._getEntityOptions();
    const tlRaw = c.time_lines ?? 'off';
    const tlOn = editorStoredOptionOn(tlRaw);
    const tlPeriod = tlOn ? String(tlRaw).trim() : '';
    const vlRaw = c.value_lines ?? 'off';
    const vlOn = editorStoredOptionOn(vlRaw);
    const vlStep = vlOn ? String(vlRaw).trim() : '';

    return html`
      <div class="editor">
              <div class="section">
                <div class="section-header">Title</div>
                <div class="option-row option-row-toggle">
                  <label class="toggle-row">
                    <span class="toggle-label">Show title</span>
                    <span class="toggle-switch">
                      <input
                        type="checkbox"
                        class="toggle-input"
                        .checked=${c.show_title !== false}
                        @change=${(e) => this._valueChanged('show_title', e.target.checked)}
                      />
                      <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    </span>
                  </label>
                </div>
                ${c.show_title !== false
                  ? html`
                      <div class="option-row">
                        <label class="option-label">Title</label>
                        <input
                          type="text"
                          class="input"
                          placeholder="Card title"
                          .value=${c.title ?? ''}
                          @input=${(e) => this._valueChanged('title', e.target.value)}
                        />
                      </div>
                      <div class="option-row">
                        <label class="option-label">Position</label>
                        <select
                          class="select"
                          .value=${c.title_position ?? 'top'}
                          @change=${(e) => this._valueChanged('title_position', e.target.value)}
                        >
                          <option value="top">Top</option>
                          <option value="bottom">Bottom</option>
                        </select>
                      </div>
                    `
                  : nothing}
              </div>
              <div class="section">
                <div class="section-header">Legend</div>
                <div class="option-row option-row-toggle">
                  <label class="toggle-row">
                    <span class="toggle-label">Show legend</span>
                    <span class="toggle-switch">
                      <input
                        type="checkbox"
                        class="toggle-input"
                        .checked=${c.show_legend !== false}
                        @change=${(e) => this._valueChanged('show_legend', e.target.checked)}
                      />
                      <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    </span>
                  </label>
                </div>
                ${c.show_legend !== false
                  ? html`
                      <div class="option-row">
                        <label class="option-label">Legend position</label>
                        <select
                          class="select"
                          .value=${c.legend_position ?? 'bottom'}
                          @change=${(e) => this._valueChanged('legend_position', e.target.value)}
                        >
                          <option value="top">Top</option>
                          <option value="bottom">Bottom</option>
                        </select>
                      </div>
                      <div class="option-row">
                        <label class="option-label">Radius (px)</label>
                        <input
                          type="number"
                          class="input narrow"
                          min="0"
                          max="24"
                          .value=${c.legend_radius != null && c.legend_radius !== '' ? c.legend_radius : ''}
                          placeholder="3"
                          @input=${(e) => {
                            const v = e.target.value.trim();
                            this._valueChanged('legend_radius', v === '' ? undefined : parseInt(v, 10) || 0);
                          }}
                        />
                      </div>
                      <div class="option-row option-row-toggle">
                        <label class="toggle-row">
                          <span class="toggle-label">Show state</span>
                          <span class="toggle-switch">
                            <input
                              type="checkbox"
                              class="toggle-input"
                              .checked=${resolveBool(c.show_state, true)}
                              @change=${(e) => {
                                const on = e.target.checked;
                                if (!on) this._valueChanged('show_unit', false);
                                this._valueChanged('show_state', on);
                              }}
                            />
                            <span class="toggle-track"><span class="toggle-thumb"></span></span>
                          </span>
                        </label>
                      </div>
                      ${resolveBool(c.show_state, true)
                        ? html`
                            <div class="option-row option-row-toggle">
                              <label class="toggle-row">
                                <span class="toggle-label">Show unit</span>
                                <span class="toggle-switch">
                                  <input
                                    type="checkbox"
                                    class="toggle-input"
                                    .checked=${resolveBool(c.show_unit, false)}
                                    @change=${(e) => this._valueChanged('show_unit', e.target.checked)}
                                  />
                                  <span class="toggle-track"><span class="toggle-thumb"></span></span>
                                </span>
                              </label>
                            </div>
                            ${resolveBool(c.show_unit, false)
                              ? html`
                                  <div class="option-row">
                                    <label class="option-label">Unit source</label>
                                    <select
                                      class="select"
                                      .value=${c.unit_source ?? 'automatic'}
                                      @change=${(e) => this._valueChanged('unit_source', e.target.value)}
                                    >
                                      <option value="automatic">Automatic</option>
                                      <option value="custom">Custom</option>
                                    </select>
                                  </div>
                                  ${(c.unit_source ?? 'automatic') === 'custom'
                                    ? html`
                                        <div class="option-row">
                                          <label class="option-label">Custom unit</label>
                                          <input
                                            type="text"
                                            class="input"
                                            .value=${c.unit_custom ?? ''}
                                            placeholder="e.g. kWh, %"
                                            @input=${(e) => this._valueChanged('unit_custom', e.target.value)}
                                          />
                                        </div>
                                      `
                                    : nothing}
                                `
                              : nothing}
                          `
                        : nothing}
                    `
                  : nothing}
              </div>

        <div class="section">
          <div class="section-header">Chart</div>
          <div class="option-row">
            <label class="option-label">Time range — default 7 days (dd:hh:mm)</label>
            <input
              type="text"
              class="input"
              placeholder="07:00:00"
              .value=${c.time_range ?? '07:00:00'}
              @input=${(e) => this._valueChanged('time_range', e.target.value)}
            />
          </div>
          <div class="option-row">
            <label class="option-label">Smoothing (0–10)</label>
            <input
              type="number"
              class="input"
              min="0"
              max="10"
              .value=${c.smoothing ?? 0}
              @input=${(e) => this._valueChanged('smoothing', parseFloat(e.target.value) || 0)}
            />
          </div>
          <div class="option-row">
            <label class="option-label">Alignment</label>
            <select
              class="select"
              .value=${c.alignment ?? 'left'}
              @change=${(e) => this._valueChanged('alignment', e.target.value)}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
          <div class="option-row">
            <label class="option-label">Show time lines</label>
            <select
              class="select"
              .value=${tlOn ? 'on' : 'off'}
              @change=${(e) => {
                const v = e.target.value;
                if (v === 'off') {
                  this._valueChanged('time_lines', 'off');
                  return;
                }
                const prev = this._config.time_lines;
                const prevStr = prev == null ? '' : String(prev).trim();
                const prevLow = prevStr.toLowerCase();
                const period =
                  prevLow !== '' && prevLow !== 'off' ? prevStr : '01:00:00';
                this._valueChanged('time_lines', period);
              }}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </div>
          ${tlOn
            ? html`
                <div class="option-row">
                  <label class="option-label">Time line interval (dd:hh:mm)</label>
                  <input
                    type="text"
                    class="input"
                    placeholder="e.g. 01:00:00"
                    .value=${tlPeriod}
                    @input=${(e) => {
                      const v = e.target.value.trim();
                      this._valueChanged('time_lines', v || '01:00:00');
                    }}
                  />
                </div>
              `
            : nothing}
          <div class="option-row">
            <label class="option-label">Show value lines</label>
            <select
              class="select"
              .value=${vlOn ? 'on' : 'off'}
              @change=${(e) => {
                const v = e.target.value;
                if (v === 'off') {
                  this._valueChanged('value_lines', 'off');
                  return;
                }
                const prev = this._config.value_lines;
                const prevStr = prev == null ? '' : String(prev).trim();
                const prevLow = prevStr.toLowerCase();
                const step =
                  prevLow !== '' && prevLow !== 'off' ? prevStr : '500';
                this._valueChanged('value_lines', step);
              }}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </div>
          ${vlOn
            ? html`
                <div class="option-row">
                  <label class="option-label">Value line step</label>
                  <input
                    type="text"
                    class="input"
                    placeholder="e.g. 500"
                    .value=${vlStep}
                    @input=${(e) => {
                      const v = e.target.value.trim();
                      this._valueChanged('value_lines', v || '500');
                    }}
                  />
                </div>
              `
            : nothing}
        </div>

        <div class="section">
          <div class="section-header">Entities</div>
          <div class="option-help">Add entities with numeric state. Recorder history is plotted over the card time range. Any option (including entity, name, color) accepts Jinja templates.</div>
          ${entities.map((ent, i) => {
            const expanded = this._expandedEntities[i] ?? isTemplate(ent.entity);
            const rows = (ent.entity || '').split('\n').length;
            const th = ent.color_threshold || [];
            const colorVal = ent.color ?? '';
            const entitySwatchBg = editorColorSwatchBackground(colorVal);
            const entityHex6 = editorHex6ForColorInput(colorVal);
            return html`
              <div class="entity-row">
                <div class="entity-fields">
                  <div class="entity-primary-row">
                    <div class="entity-input-wrap">
                      ${expanded
                        ? html`<textarea
                            class="input entity-textarea"
                            placeholder="Entity ID or Jinja template"
                            .value=${ent.entity || ''}
                            rows="${Math.max(6, rows + 1)}"
                            @input=${(e) => this._entityChanged(i, 'entity', e.target.value)}
                          ></textarea>`
                        : html`<input
                            type="text"
                            class="input entity-input"
                            list="eid-${i}"
                            placeholder="Entity ID or Jinja template"
                            .value=${ent.entity || ''}
                            @input=${(e) => this._entityChanged(i, 'entity', e.target.value)}
                          />
                          <datalist id="eid-${i}">${entityOptions.map((id) => html`<option value="${id}"></option>`)}</datalist>`}
                    </div>
                    <button type="button" class="expand-btn" @click=${() => this._toggleEntityExpand(i)}>
                      <ha-icon icon="${expanded ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'}"></ha-icon>
                    </button>
                  </div>
                  <div class="entity-options-row">
                    <input
                      type="text"
                      class="input entity-name-input"
                      placeholder="Name"
                      .value=${ent.name ?? ''}
                      @input=${(e) => this._entityChanged(i, 'name', e.target.value || undefined)}
                    />
                    <div class="color-with-swatch">
                      <span
                        class="color-swatch ${entitySwatchBg ? '' : 'color-swatch-empty'}"
                        style="${entitySwatchBg ? `background:${entitySwatchBg}` : ''}"
                      ></span>
                      ${entityHex6
                        ? html`<input
                            type="color"
                            class="editor-color-native"
                            .value=${entityHex6}
                            @input=${(e) => this._entityChanged(i, 'color', e.target.value)}
                          />`
                        : nothing}
                      <input
                        type="text"
                        class="input color-input"
                        placeholder="Color (hex or var)"
                        .value=${colorVal}
                        @input=${(e) => this._entityChanged(i, 'color', e.target.value.trim() || undefined)}
                      />
                    </div>
                    <input
                      type="number"
                      class="input narrow"
                      placeholder="Line width (px)"
                      .value=${ent.line_width ?? ''}
                      @input=${(e) => {
                        const v = e.target.value;
                        this._entityChanged(i, 'line_width', v === '' ? undefined : parseFloat(v));
                      }}
                    />
                  </div>
                  <div class="entity-options-row">
                    <label class="option-label">Fill</label>
                    <select
                      class="select flex1"
                      .value=${normalizeFillMode(ent.fill)}
                      @change=${(e) => this._entityChanged(i, 'fill', e.target.value)}
                    >
                      <option value="none">None</option>
                      <option value="solid">Solid</option>
                      <option value="gradient_up">Gradient up</option>
                      <option value="gradient_down">Gradient down</option>
                      <option value="gradient_left">Gradient left</option>
                      <option value="gradient_right">Gradient right</option>
                    </select>
                    <input
                      type="number"
                      class="input narrow"
                      min="0"
                      max="100"
                      placeholder="opacity"
                      .value=${ent.fill_opacity ?? ''}
                      @input=${(e) => {
                        const v = e.target.value;
                        this._entityChanged(i, 'fill_opacity', v === '' ? undefined : parseFloat(v));
                      }}
                    />
                  </div>
                  <div class="entity-options-row">
                    <label class="option-label">Color threshold smoothing (0–10)</label>
                    <input
                      type="number"
                      class="input narrow"
                      min="0"
                      max="10"
                      .value=${ent.color_threshold_smoothing ?? 0}
                      @input=${(e) => this._entityChanged(i, 'color_threshold_smoothing', parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  <div class="threshold-block">
                    ${th.map((row, ti) => {
                      const thColor = row.color ?? '';
                      const thSwatchBg = editorColorSwatchBackground(thColor);
                      const thHex6 = editorHex6ForColorInput(thColor);
                      return html`
                        <div class="threshold-row">
                          <input
                            type="number"
                            class="input narrow"
                            .value=${row.value}
                            @input=${(e) => this._thresholdChanged(i, ti, 'value', parseFloat(e.target.value) || 0)}
                          />
                          <div class="color-with-swatch threshold-color-wrap">
                            <span
                              class="color-swatch ${thSwatchBg ? '' : 'color-swatch-empty'}"
                              style="${thSwatchBg ? `background:${thSwatchBg}` : ''}"
                            ></span>
                            ${thHex6
                              ? html`<input
                                  type="color"
                                  class="editor-color-native"
                                  .value=${thHex6}
                                  @input=${(e) => this._thresholdChanged(i, ti, 'color', e.target.value)}
                                />`
                              : nothing}
                            <input
                              type="text"
                              class="input color-input threshold-color-input"
                              placeholder="Color (hex or var)"
                              .value=${thColor}
                              @input=${(e) =>
                                this._thresholdChanged(i, ti, 'color', e.target.value.trim() || undefined)}
                            />
                          </div>
                          <button type="button" class="remove-btn" @click=${() => this._removeThreshold(i, ti)}>
                            <ha-icon icon="mdi:delete"></ha-icon>
                          </button>
                        </div>
                      `;
                    })}
                    <button type="button" class="add-threshold" @click=${() => this._addThreshold(i)}>
                      Add colour threshold
                    </button>
                  </div>
                </div>
                <button type="button" class="remove-btn" @click=${() => this._removeEntity(i)}>
                  <ha-icon icon="mdi:close"></ha-icon>
                </button>
              </div>
            `;
          })}
          <button type="button" class="add-btn" @click=${() => this._addEntity()}>
            <ha-icon icon="mdi:plus"></ha-icon>
            Add entity
          </button>
        </div>
      </div>
    `;
  }

  static styles = css`
    .editor {
      padding: 20px;
      background: var(--secondary-background-color, var(--card-background-color, #1c1c1c));
      color: var(--primary-text-color);
      font-family: var(--mdc-typography-font-family, Roboto, sans-serif);
      max-width: 100%;
      box-sizing: border-box;
    }
    .section {
      margin-bottom: 20px;
      padding: 16px;
      background: var(--card-background-color, var(--ha-card-background, rgba(0, 0, 0, 0.2)));
      border-radius: 12px;
      border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
    }
    .section:last-child {
      margin-bottom: 0;
    }
    .section-header {
      font-size: 12px;
      font-weight: 600;
      color: var(--secondary-text-color);
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .section-subheader {
      font-size: 11px;
      font-weight: 600;
      color: var(--secondary-text-color);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      margin-top: 4px;
    }
    .option-row {
      margin-bottom: 16px;
    }
    .option-row:last-of-type {
      margin-bottom: 0;
    }
    .option-label {
      display: block;
      font-size: 14px;
      color: var(--primary-text-color);
      margin-bottom: 6px;
    }
    .option-row-toggle {
      margin-bottom: 14px;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      cursor: pointer;
      gap: 12px;
    }
    .toggle-label {
      font-size: 14px;
      color: var(--primary-text-color);
    }
    .toggle-switch {
      position: relative;
      flex-shrink: 0;
    }
    .toggle-input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
      margin: 0;
      pointer-events: none;
    }
    .toggle-track {
      display: flex;
      align-items: center;
      width: 44px;
      height: 24px;
      border-radius: 12px;
      background: var(--disabled-color, rgba(255, 255, 255, 0.2));
      transition: background 0.2s ease;
      padding: 0 2px;
      box-sizing: border-box;
    }
    .toggle-input:checked + .toggle-track {
      background: var(--primary-color);
    }
    .toggle-thumb {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      transition: transform 0.2s ease;
    }
    .toggle-input:checked + .toggle-track .toggle-thumb {
      transform: translateX(20px);
      background: rgba(255, 255, 255, 0.95);
    }
    .option-help {
      font-size: 12px;
      color: var(--secondary-text-color);
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .input,
    .select {
      width: 100%;
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
      background: var(--card-background-color, var(--ha-card-background, #fff));
      color: var(--primary-text-color);
      font-size: 14px;
      box-sizing: border-box;
    }
    .input:focus,
    .select:focus {
      outline: none;
      border-color: var(--primary-color);
    }
    .input:disabled,
    .input.disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .select {
      cursor: pointer;
    }
    .select option {
      background: var(--card-background-color, var(--ha-card-background, #fff));
      color: var(--primary-text-color);
    }
    .input.narrow {
      width: auto;
      min-width: 60px;
      max-width: 120px;
    }
    .flex1 {
      flex: 1;
      min-width: 0;
      width: auto;
    }
    .entity-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 12px;
      padding: 14px;
      background: var(--input-fill-color, rgba(0, 0, 0, 0.2));
      border-radius: 12px;
      border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.08));
    }
    .entity-fields {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }
    .entity-primary-row {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      width: 100%;
    }
    .entity-input-wrap {
      flex: 1;
      min-width: 0;
    }
    .entity-input-wrap .entity-input {
      width: 100%;
      box-sizing: border-box;
    }
    .entity-input-wrap .entity-textarea {
      resize: vertical;
      min-height: 80px;
    }
    .entity-options-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .entity-options-row .entity-name-input {
      flex: 1;
      min-width: 100px;
    }
    .color-with-swatch {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .color-swatch {
      width: 24px;
      height: 24px;
      border-radius: 6px;
      flex-shrink: 0;
      border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.2));
    }
    .color-swatch-empty {
      background: var(--disabled-color, rgba(127, 127, 127, 0.35));
    }
    .editor-color-native {
      width: 48px;
      height: 40px;
      padding: 2px;
      border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
      border-radius: 10px;
      cursor: pointer;
      flex-shrink: 0;
      box-sizing: border-box;
      background: var(--card-background-color, transparent);
    }
    .entity-options-row .color-input {
      min-width: 80px;
      max-width: 120px;
    }
    .threshold-color-wrap {
      flex: 1;
      min-width: 120px;
    }
    .threshold-color-wrap .threshold-color-input {
      flex: 1;
      min-width: 80px;
      width: 100%;
      max-width: none;
      box-sizing: border-box;
    }
    .expand-btn {
      padding: 8px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--secondary-text-color);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .expand-btn:hover {
      color: var(--primary-color);
      background: rgba(var(--rgb-primary-color), 0.1);
    }
    .remove-btn {
      padding: 8px;
      border: none;
      border-radius: 12px;
      background: transparent;
      color: var(--secondary-text-color);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .remove-btn:hover {
      color: var(--error-color, #f44336);
      background: rgba(var(--rgb-error-color, 244, 67, 54), 0.15);
    }
    .threshold-block {
      margin-top: 4px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
    }
    .threshold-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      width: 100%;
    }
    .threshold-row .input.narrow {
      flex-shrink: 0;
    }
    /* Only stretch the text colour field — do not target type="color" (breaks preview picker layout). */
    .threshold-row .threshold-color-input {
      flex: 1;
      min-width: 80px;
    }
    .add-threshold {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px dashed var(--divider-color);
      background: transparent;
      color: var(--primary-color);
      font-size: 13px;
      cursor: pointer;
      width: 100%;
      box-sizing: border-box;
    }
    .add-threshold:hover {
      background: rgba(var(--rgb-primary-color), 0.1);
      border-color: var(--primary-color);
    }
    .add-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border-radius: 12px;
      border: 1px dashed var(--divider-color);
      background: transparent;
      color: var(--primary-color);
      font-size: 14px;
      cursor: pointer;
      width: 100%;
      justify-content: center;
    }
    .add-btn:hover {
      background: rgba(var(--rgb-primary-color), 0.1);
      border-color: var(--primary-color);
    }
  `;
}

if (!customElements.get('aesthetic-history-graph-card-editor')) {
  customElements.define('aesthetic-history-graph-card-editor', AestheticHistoryGraphCardEditor);
}

const AESTHETIC_HISTORY_GRAPH_CARD_TYPE = 'custom:aesthetic-history-graph-card';
const AESTHETIC_HISTORY_GRAPH_CARD_PICKER = {
  type: AESTHETIC_HISTORY_GRAPH_CARD_TYPE,
  name: 'Aesthetic History Graph Card',
  preview: false,
  description:
    'Time-series history chart for numeric entities with custom colours, fills, thresholds, and grid lines.',
  documentationURL: 'https://github.com/kattcrazy/Aesthetic-History-Graph-Card',
};

if (window.customCards && Array.isArray(window.customCards)) {
  if (!window.customCards.some((c) => c.type === AESTHETIC_HISTORY_GRAPH_CARD_TYPE)) {
    window.customCards.push(AESTHETIC_HISTORY_GRAPH_CARD_PICKER);
  }
} else if (window.registerCustomCard) {
  window.registerCustomCard(AESTHETIC_HISTORY_GRAPH_CARD_PICKER);
}
