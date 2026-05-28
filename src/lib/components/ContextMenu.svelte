<script lang="ts" module>
  /**
   * Menu item shapes shared between the page that builds the menu and this
   * component that renders it.
   */
  export type MenuItem =
    | {
        kind: "item";
        label: string;
        shortcut?: string;
        action: () => void;
        disabled?: boolean;
      }
    | { kind: "separator" }
    | { kind: "submenu"; label: string; items: MenuItem[] };
</script>

<script lang="ts">
  import { onMount, untrack } from "svelte";

  let {
    items,
    x,
    y,
    onClose,
  }: {
    items: MenuItem[];
    x: number;
    y: number;
    onClose: () => void;
  } = $props();

  let rootEl: HTMLDivElement | null = $state(null);
  let openSubmenuIdx: number | null = $state(null);
  let openSubmenuRowEl: HTMLDivElement | null = $state(null);
  let subMenuEl: HTMLDivElement | null = $state(null);
  let subPos = $state({ x: 0, y: 0 });

  // Main menu position, clamped to viewport. Initialised via untrack so Svelte
  // doesn't warn about one-shot prop capture; the $effect below keeps it live.
  let adjustedX = $state(untrack(() => x));
  let adjustedY = $state(untrack(() => y));

  $effect(() => {
    const margin = 6;
    let nx = x;
    let ny = y;
    if (rootEl) {
      const rect = rootEl.getBoundingClientRect();
      if (nx + rect.width > window.innerWidth - margin) {
        nx = Math.max(margin, window.innerWidth - rect.width - margin);
      }
      if (ny + rect.height > window.innerHeight - margin) {
        ny = Math.max(margin, window.innerHeight - rect.height - margin);
      }
    }
    adjustedX = nx;
    adjustedY = ny;
  });

  // Position the submenu so it stays inside the viewport. Tries the right side
  // of the parent row first; flips to the left if it would clip; pushes up if
  // it would extend past the bottom.
  $effect(() => {
    if (
      openSubmenuIdx === null ||
      !openSubmenuRowEl ||
      !subMenuEl
    ) {
      return;
    }
    const rowRect = openSubmenuRowEl.getBoundingClientRect();
    const subRect = subMenuEl.getBoundingClientRect();
    const margin = 6;
    let sx = rowRect.right + 2;
    let sy = rowRect.top - 4;
    if (sx + subRect.width > window.innerWidth - margin) {
      sx = Math.max(margin, rowRect.left - subRect.width - 2);
    }
    if (sy + subRect.height > window.innerHeight - margin) {
      sy = Math.max(margin, window.innerHeight - subRect.height - margin);
    }
    subPos = { x: sx, y: sy };
  });

  function chooseItem(item: MenuItem) {
    if (item.kind === "item" && !item.disabled) {
      item.action();
      onClose();
    }
  }

  function openSubmenu(idx: number, rowEl: HTMLDivElement) {
    openSubmenuIdx = idx;
    openSubmenuRowEl = rowEl;
  }

  onMount(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The submenu is rendered as a sibling (position: fixed) rather than a
      // descendant of rootEl, so we must check both elements explicitly.
      // Otherwise mousedown on a submenu item is treated as an "outside" click
      // and closes the menu before the button's onclick can fire.
      if (rootEl && rootEl.contains(target)) return;
      if (subMenuEl && subMenuEl.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div
  class="ctx-menu"
  role="menu"
  bind:this={rootEl}
  style:left="{adjustedX}px"
  style:top="{adjustedY}px"
>
  {#each items as item, idx}
    {#if item.kind === "separator"}
      <div class="ctx-sep" role="separator"></div>
    {:else if item.kind === "item"}
      <button
        type="button"
        class="ctx-item"
        class:disabled={item.disabled}
        disabled={item.disabled}
        role="menuitem"
        onmouseenter={() => (openSubmenuIdx = null)}
        onclick={() => chooseItem(item)}
      >
        <span class="ctx-label">{item.label}</span>
        {#if item.shortcut}
          <span class="ctx-shortcut">{item.shortcut}</span>
        {/if}
      </button>
    {:else if item.kind === "submenu"}
      {@const submenuItem = item}
      <div
        class="ctx-submenu-row"
        role="none"
        onmouseenter={(e) => openSubmenu(idx, e.currentTarget as HTMLDivElement)}
      >
        <button
          type="button"
          class="ctx-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={openSubmenuIdx === idx}
        >
          <span class="ctx-label">{submenuItem.label}</span>
          <span class="ctx-arrow">▸</span>
        </button>
      </div>
    {/if}
  {/each}
</div>

{#if openSubmenuIdx !== null}
  {@const open = items[openSubmenuIdx]}
  {#if open && open.kind === "submenu"}
    <div
      class="ctx-submenu"
      role="menu"
      bind:this={subMenuEl}
      style:left="{subPos.x}px"
      style:top="{subPos.y}px"
    >
      {#each open.items as sub}
        {#if sub.kind === "separator"}
          <div class="ctx-sep" role="separator"></div>
        {:else if sub.kind === "item"}
          <button
            type="button"
            class="ctx-item"
            class:disabled={sub.disabled}
            disabled={sub.disabled}
            role="menuitem"
            onclick={() => chooseItem(sub)}
          >
            <span class="ctx-label">{sub.label}</span>
            {#if sub.shortcut}
              <span class="ctx-shortcut">{sub.shortcut}</span>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
{/if}

<style>
  /* Context-menu tokens, defaulting to dark.
     The light overrides live under `[data-theme="light"]` so the same
     selectors apply across both themes without having to fork them. */
  :global(:root) {
    --ctx-bg: #2b2d31;
    --ctx-border: #404249;
    --ctx-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    --ctx-fg: #d4d4d4;
    --ctx-hover-bg: #5865f2;
    --ctx-hover-fg: #ffffff;
    --ctx-disabled: #6e7075;
    --ctx-shortcut: #8e9097;
    --ctx-shortcut-hover: #d1d3df;
    --ctx-arrow: #8e9097;
  }
  :global(:root[data-theme="light"]) {
    --ctx-bg: #ffffff;
    --ctx-border: #d4d4d4;
    --ctx-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    --ctx-fg: #1f1f1f;
    --ctx-hover-bg: #0078d4;
    --ctx-hover-fg: #ffffff;
    --ctx-disabled: #a0a0a0;
    --ctx-shortcut: #6c6e75;
    --ctx-shortcut-hover: #e3eefb;
    --ctx-arrow: #6c6e75;
  }

  .ctx-menu,
  .ctx-submenu {
    position: fixed;
    z-index: 1000;
    min-width: 220px;
    background: var(--ctx-bg);
    border: 1px solid var(--ctx-border);
    border-radius: 6px;
    box-shadow: var(--ctx-shadow);
    padding: 4px;
    font-size: 13px;
    color: var(--ctx-fg);
    user-select: none;
  }
  .ctx-submenu {
    min-width: 200px;
  }

  .ctx-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--ctx-border);
  }

  .ctx-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 5px 10px;
    background: transparent;
    color: inherit;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    gap: 16px;
  }
  .ctx-item:hover:not(.disabled),
  .ctx-item:focus-visible:not(.disabled) {
    background: var(--ctx-hover-bg);
    color: var(--ctx-hover-fg);
    outline: none;
  }
  .ctx-item.disabled {
    color: var(--ctx-disabled);
    cursor: default;
  }
  .ctx-label {
    flex: 1;
  }
  .ctx-shortcut {
    color: var(--ctx-shortcut);
    font-size: 11px;
  }
  .ctx-item:hover .ctx-shortcut {
    color: var(--ctx-shortcut-hover);
  }
  .ctx-arrow {
    font-size: 10px;
    color: var(--ctx-arrow);
  }
  .ctx-item:hover .ctx-arrow {
    color: var(--ctx-hover-fg);
  }
</style>
