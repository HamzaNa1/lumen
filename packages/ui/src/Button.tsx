export const Button = ({ children, variant = "secondary", type = "button", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: "primary" | "secondary" | "ghost" }): React.ReactElement => (
  <button type={type} className={`button button-${variant}`} {...props}>{children}</button>
);
