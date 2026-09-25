import { Menu } from "@base-ui/react/menu";
import { Tabs } from "@base-ui/react/tabs";
import type { ReactElement, ReactNode } from "react";

export const DropdownMenu = ({
  trigger,
  children,
  side = "bottom",
  align = "end",
  className,
}: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly side?: "top" | "bottom";
  readonly align?: "start" | "center" | "end";
  readonly className?: string;
}): React.ReactElement => (
  <Menu.Root>
    <Menu.Trigger render={trigger} />
    <Menu.Portal>
      <Menu.Positioner className="menu-positioner" side={side} align={align} sideOffset={6}>
        <Menu.Popup className={`menu-popup${className === undefined ? "" : ` ${className}`}`}>
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

export const DropdownItem = ({
  children,
  icon,
  trailing,
  onClick,
  disabled = false,
  tone = "default",
}: {
  readonly children: ReactNode;
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly tone?: "default" | "danger";
}): React.ReactElement => (
  <Menu.Item className="menu-item" data-tone={tone} disabled={disabled} onClick={onClick}>
    {icon === undefined ? null : <span className="menu-item-icon">{icon}</span>}
    <span className="menu-item-label">{children}</span>
    {trailing === undefined ? null : <span className="menu-item-trailing">{trailing}</span>}
  </Menu.Item>
);

export const DropdownSeparator = (): React.ReactElement => (
  <Menu.Separator className="menu-separator" />
);

export const DropdownGroup = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): React.ReactElement => (
  <Menu.Group>
    <Menu.GroupLabel className="menu-label">{label}</Menu.GroupLabel>
    {children}
  </Menu.Group>
);

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
}

export const SegmentedControl = <T extends string>({
  label,
  value,
  options,
  onValueChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<SegmentOption<T>>;
  readonly onValueChange: (value: T) => void;
}): React.ReactElement => (
  <Tabs.Root
    value={value}
    onValueChange={(next) => {
      const option = options.find((entry) => entry.value === next);
      if (option !== undefined) onValueChange(option.value);
    }}
  >
    <Tabs.List className="segmented" aria-label={label}>
      {options.map((option) => (
        <Tabs.Tab key={option.value} className="segmented-item" value={option.value}>
          {option.label}
          {option.count === undefined ? null : (
            <span className="segmented-count">{option.count}</span>
          )}
        </Tabs.Tab>
      ))}
      <Tabs.Indicator className="segmented-indicator" />
    </Tabs.List>
  </Tabs.Root>
);
