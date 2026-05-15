# Aesthetic History Graph Card

A time-series history graph with configurable colours, fills, thresholds, and grid lines.

All of my (@kattcrazy)'s cards are styled similarly and support Jinja in most, if not all option fields.

## Installation

### HACS (recommended)

1. Open HACS and open the 3-dot menu (top right). Select Custom repositories.
2. Add this repo
   - Repository: `https://github.com/kattcrazy/Aesthetic-History-Graph-Card`
   - Type : `Dashboard`
3. Search for Aesthetic History Graph Card and Download

### Manual

1. Download `Aesthetic-History-Graph-Card.js` from the [releases](https://github.com/kattcrazy/Aesthetic-History-Graph-Card/releases) page
2. Place it in your `config/www/` folder
3. Add the resource in the Lovelace config:

```yaml
resources:
  - url: /local/Aesthetic-History-Graph-Card.js
    type: module
```

## Configuration

### Card options

All options support Jinja templates (strings containing `{{ }}`).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `alignment` | `left`, `center`, `right` | `left` | Horizontal alignment for title and legend |
| `entities` | array | `[]` | Entity list (see below) |
| `legend_position` | `top`, `bottom` | `bottom` | Legend placement |
| `legend_radius` | number | `3` | Radius of legend colour swatches |
| `show_legend` | boolean | `true` | Show legend |
| `show_state` | boolean | `true` | Show the current numeric value in the legend |
| `show_title` | boolean | `true` | Show title |
| `show_unit` | boolean | `false` | Show the unit next to the value in the legend (only when `show_state` is true) |
| `unit_source` | `automatic`, `custom` | `automatic` | Can be automatic or custom text |
| `unit_custom` | string | — | When `unit_source` is `custom` |
| `smoothing` | number | `0` | Path smoothing from `0` (straight segments) to `10` (strongest curve) |
| `time_lines` | `off` or `dd:hh:mm` | `off` | Vertical time guides (for example `00:01:00` would mean a line every 1 hour ) |
| `time_range` | string `dd:hh:mm` | `07:00:00` | History window |
| `title` | string | — | Card title text |
| `title_position` | `top`, `bottom` | `top` | Title placement |
| `value_lines` | `off` or number | `off` | Horizontal guides at that numeric interval (for example `500` would mean lines at 0, 500, 1000, …) |

### Entity options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `color` | string | auto | Stroke colour (hex or CSS variable). Omit for default palette (same as Stacked Bar Card). Supports Jinja. |
| `color_threshold` | array | — | List of `{ value, color }` for stepped colouring by numeric state along the series |
| `color_threshold_smoothing` | number | `0` | Softness between threshold colours on stroke and fill (`0` = hard steps, `10` = very soft) |
| `entity` | string | required | Entity ID or Jinja template |
| `fill` | `false`, `true`, `gradient_up`, `gradient_down`, `gradient_left`, `gradient_right` | `false` | Area fill |
| `fill_opacity` | number | `40` | Fill opacity from `0` to `100` |
| `line_width` | number | `2` | Line thickness (px) |
| `name` | string | — | Override name; omit to use friendly name |
| `show_state` | boolean | card default | Per-series override for showing the value in the legend |

### Full config & options

For your copy-paste convenience!

```yaml
type: custom:aesthetic-history-graph-card

alignment: left/center/right
show_title: true/false
title: Power
title_position: top/bottom

show_legend: true/false
show_state: true
show_unit: true
unit_source: automatic
legend_position: top/bottom
# legend_radius: 6              # optional — px, legend swatches only (default 3)

time_range: 07:00:00          # dd:hh:mm — last 7 days
time_lines: off                 # off or dd:hh:mm (midnight-aligned)
value_lines: off                # off or number (e.g. 500)

smoothing: 0                    # 0–10

entities:
  - entity: sensor.grid_power   # Or use Jinja templating
    name: Grid
    color: '#93B5F2'
    line_width: 2
    fill: gradient_down
    fill_opacity: 35
  - entity: sensor.solar_power
    name: Solar
    color: '#FFE08A'
    fill: true
    fill_opacity: 50
    color_threshold:
      - value: 0
        color: '#FFD54F'
      - value: 2000
        color: '#FF9800'
    color_threshold_smoothing: 3
```

## License

This project uses the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html). See [LICENSE](LICENSE) for the full legal text. In short: you can use, change, and share it freely. If you distribute a modified version, you must offer it under the same license and share the source too, so the work (and its derivatives) stay open. You cannot take this code, tweak it, and ship it as a closed product.

## About

Contributions/PRs welcome.

If this card is a good addition to your dashboards, consider supporting me [here](https://kattcrazy.nz/product/support-me/) :)
