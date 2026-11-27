const props = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const EditIcon = () => (
  <svg {...props} aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M14 6l4 4" /></svg>
);
export const TrashIcon = () => (
  <svg {...props} aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
);
export const ResetIcon = () => (
  <svg {...props} aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7" /><path d="M4 4v4.7h4.7" /></svg>
);
export const PinIcon = () => (
  <svg {...props} aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" /><path d="M12 15v6" /></svg>
);
export const CheckIcon = () => (
  <svg {...props} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
);
export const IgnoreIcon = () => (
  <svg {...props} aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const BackIcon = () => (
  <svg {...props} aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
);
