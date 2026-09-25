import { Button as BaseButton } from "@base-ui/react/button";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

export const Button = ({
  children,
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: BaseButton.Props & {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}): React.ReactElement => (
  <BaseButton
    type={type}
    className={`button button-${variant}${size === "md" ? "" : ` button-${size}`}${className === undefined ? "" : ` ${className}`}`}
    {...props}
  >
    {children}
  </BaseButton>
);
