import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";

export const Popover = ({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "end",
  className,
}: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly side?: "top" | "bottom";
  readonly align?: "start" | "center" | "end";
  readonly className?: string;
}): React.ReactElement => (
  <BasePopover.Root open={open} onOpenChange={onOpenChange}>
    <BasePopover.Trigger render={trigger} />
    <BasePopover.Portal>
      <BasePopover.Positioner
        className="menu-positioner"
        side={side}
        align={align}
        sideOffset={8}
        collisionPadding={10}
      >
        <BasePopover.Popup
          className={`popover-popup${className === undefined ? "" : ` ${className}`}`}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>
);

export const PopoverTitle = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <BasePopover.Title className="popover-title">{children}</BasePopover.Title>
);
