# UI definition contract

## Screen shape

- Stable ID fields use 1–128 alphanumeric, underscore, or hyphen characters and start with an alphanumeric character.
- `reviewStatus` is `unreviewed`, `needs-action`, or `approved`.
- `viewports` contains one or both of `desktop` and `mobile`.
- A screen has 1–50 states and no duplicate state IDs.
- Each state contains one static HTML fragment of at most 200 KB.
- The total UI HTML for one product is at most 2 MB.
- A screen has at most 200 specification links.

## Selectable components

Add a unique `data-baynex-id` to every element that can receive feedback. Use component IDs containing only letters, digits, colon, period, underscore, or hyphen. Keep IDs stable across states and later updates.

```html
<main data-baynex-id="checkout.page">
  <button data-baynex-id="checkout.submit">Place order</button>
</main>
```

Each state must contain at least one valid component ID. Do not use a CSS selector or DOM path as the persistent component identity.

## Forbidden HTML

Do not include:

- `script`, `iframe`, `object`, `embed`, `base`, `meta`, or `link` elements
- inline event handlers such as `onclick`
- `href`, `action`, `formaction`, or `target` navigation attributes
- `javascript:` or `data:text/html` URLs
- external images, fonts, API calls, form submission, or runtime JavaScript

Use static HTML and inline CSS. Use `data:` images only when an image is essential.

## Specification links

Use an active, non-technical document in the same product. `documentId` is canonical; `heading` and `requirementId` are optional display/search aids. Allowed relations are:

- `implements`: the UI realizes the requirement
- `supports`: the UI provides part of or an auxiliary path for the requirement
- `explains`: the UI illustrates the requirement
