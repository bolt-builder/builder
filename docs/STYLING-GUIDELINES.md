# Styling Guidelines for Bolt

## Dark Mode Implementation

This codebase uses a **dark-first** design. When styling components, follow these patterns:

### WRONG - Light mode first (causes white backgrounds)

```tsx
// This will show white in light mode, only dark when dark class is present
className = 'bg-white dark:bg-gray-900';
```

### CORRECT - Use inline styles for guaranteed dark colors

```tsx
// Inline styles ALWAYS apply regardless of dark mode class
style={{ backgroundColor: '#1a1a1a' }}
```

### CORRECT - Use direct hex colors in Tailwind

```tsx
// Direct hex values work without needing dark: prefix
className = 'bg-[#1a1a1a]';
```

## Color Palette (Dark Theme)

### Neutral Dark (Generic Components)

| Element               | Color     | Usage                      |
| --------------------- | --------- | -------------------------- |
| Background (deep)     | `#0a0a0a` | Deepest background         |
| Background (sidebar)  | `#141414` | Sidebar, secondary areas   |
| Background (main)     | `#1a1a1a` | Main content areas         |
| Background (elevated) | `#2a2a2a` | Cards, active states       |
| Background (hover)    | `#333333` | Hover states               |
| Border                | `#333333` | All borders                |
| Text (primary)        | `#ffffff` | Headings, important text   |
| Text (secondary)      | `#9ca3af` | Body text, labels          |
| Text (muted)          | `#6b7280` | Placeholder, hints         |
| Accent                | `#a855f7` | Purple accent (purple-500) |

### Blue-Tinted Dark (Page & Popover Theme)

The main page body and floating UI (popovers, dropdowns) use blue-tinted dark colors for a cohesive feel:

| Element               | Color     | Usage                      |
| --------------------- | --------- | -------------------------- |
| Page background       | `#0b0d13` | Body / root background     |
| Popover / dropdown bg | `#0f1219` | Floating panel backgrounds |
| Hover (blue-tinted)   | `#1a1f2e` | Hover states in popovers   |
| Border (blue-tinted)  | `#1e293b` | Borders on floating panels |
| Shadow (floating)     | `rgba(0,0,0,0.6)` | Deep drop shadow for depth |

> **Important**: Browser default `<button>` backgrounds are gray. Always add `bg-transparent` or `border-none bg-transparent` to custom buttons in dark popovers.

## Component Patterns

### Modals/Dialogs

```tsx
<RadixDialog.Content
  className="dark" // Force dark mode context
  style={{ backgroundColor: '#1a1a1a' }}
>
```

### Sidebars

```tsx
<div
  className="border-r border-[#333]"
  style={{ backgroundColor: '#141414' }}
>
```

### Buttons (Active State)

```tsx
<button
  style={{
    backgroundColor: isActive ? '#2a2a2a' : 'transparent',
    color: isActive ? '#fff' : '#9ca3af',
  }}
>
```

## Why Inline Styles?

The project has CSS specificity issues where:

1. Tailwind's `dark:` variants require a parent `dark` class
2. Some global styles or component libraries override Tailwind classes
3. The `dark` class may not be properly propagated through portals (like Radix dialogs)

**Inline styles have the highest specificity** and will always apply, making them the most reliable way to enforce dark backgrounds.

## Future Improvements

Consider:

1. Adding `darkMode: 'class'` check to ensure `dark` class is on `<html>` or `<body>`
2. Creating CSS variables for the color palette
3. Using a theme provider that wraps portal components

---

_Created to prevent AI styling issues where light backgrounds appear instead of dark._
