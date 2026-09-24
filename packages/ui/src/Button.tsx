import { Button as BaseButton } from "@base-ui/react/button";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";

export const Button = ({
  children,
  variant = "secondary",
  className,
  type = "button",
  ...props
}: BaseButton.Props & { readonly variant?: ButtonVariant }): React.ReactElement => (
  <BaseButton
    type={type}
    className={`button button-${variant}${className === undefined ? "" : ` ${className}`}`}
    {...props}
  >
    {children}
  </BaseButton>
);
