import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form as BaseForm } from "@base-ui/react/form";
import { Input } from "@base-ui/react/input";
import { Select } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import { Check, ChevronDown, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";

export const Form = BaseForm;

interface TextFieldProps extends Omit<Input.Props, "className" | "onChange"> {
  readonly label: string;
  readonly description?: string;
  readonly className?: string;
  readonly hideLabel?: boolean;
}

export const TextField = ({
  label,
  description,
  className,
  hideLabel = false,
  ...props
}: TextFieldProps): React.ReactElement => (
  <Field.Root className={`field${className === undefined ? "" : ` ${className}`}`}>
    <Field.Label className={hideLabel ? "sr-only" : "field-label"}>{label}</Field.Label>
    <Input className="text-input" {...props} />
    {description === undefined ? null : (
      <Field.Description className="field-description">{description}</Field.Description>
    )}
  </Field.Root>
);

export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SelectFieldProps<T extends string> {
  readonly label: string;
  readonly value: T | null;
  readonly options: ReadonlyArray<SelectOption<T>>;
  readonly onValueChange: (value: T) => void;
  readonly className?: string;
  readonly hideLabel?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

export const SelectField = <T extends string>({
  label,
  value,
  options,
  onValueChange,
  className,
  hideLabel = false,
  disabled = false,
  placeholder = "Select an option",
}: SelectFieldProps<T>): React.ReactElement => (
  <Select.Root<T>
    value={value}
    items={options}
    disabled={disabled}
    onValueChange={(nextValue) => {
      if (nextValue !== null) onValueChange(nextValue);
    }}
  >
    <div className={`select-field${className === undefined ? "" : ` ${className}`}`}>
      <Select.Label className={hideLabel ? "sr-only" : "field-label"}>{label}</Select.Label>
      <Select.Trigger className="select-trigger">
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="select-icon">
          <ChevronDown aria-hidden="true" size={15} />
        </Select.Icon>
      </Select.Trigger>
    </div>
    <Select.Portal>
      <Select.Positioner className="select-positioner" sideOffset={6}>
        <Select.Popup className="select-popup">
          <Select.List>
            {options.map((option) => (
              <Select.Item className="select-item" key={option.value} value={option.value}>
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="select-indicator">
                  <Check aria-hidden="true" size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
);

export const CheckboxField = ({
  label,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}): React.ReactElement => (
  <Field.Root className="checkbox-field" disabled={disabled}>
    <Field.Label className="checkbox-label">
      <Checkbox.Root className="checkbox" checked={checked} onCheckedChange={onCheckedChange}>
        <Checkbox.Indicator className="checkbox-indicator">
          <Check aria-hidden="true" size={12} strokeWidth={3} />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span>{label}</span>
    </Field.Label>
  </Field.Root>
);

export const SwitchField = ({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
}: {
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}): React.ReactElement => (
  <Field.Root className="switch-field" disabled={disabled}>
    <Field.Label className="switch-field-label">
      <span className="switch-field-text">
        <span className="field-label">{label}</span>
        {description === undefined ? null : (
          <span className="field-description">{description}</span>
        )}
      </span>
      <Switch.Root className="switch" checked={checked} onCheckedChange={onCheckedChange}>
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
    </Field.Label>
  </Field.Root>
);

interface ModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly className?: string;
  /** Keeps the title for assistive technology but lets the content draw its own header. */
  readonly hideHeader?: boolean;
}

export const Modal = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideHeader = false,
}: ModalProps): React.ReactElement => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Viewport className="dialog-viewport">
        <Dialog.Popup className={`dialog-popup${className === undefined ? "" : ` ${className}`}`}>
          {hideHeader ? (
            <>
              <Dialog.Title className="sr-only">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="sr-only">{description}</Dialog.Description>
              )}
              <Dialog.Close
                render={
                  <Button variant="icon" className="dialog-close-floating" aria-label="Close" />
                }
              >
                <X aria-hidden="true" size={18} />
              </Dialog.Close>
            </>
          ) : (
            <div className="dialog-header">
              <div>
                <Dialog.Title className="dialog-title">{title}</Dialog.Title>
                {description === undefined ? null : (
                  <Dialog.Description className="dialog-description">
                    {description}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close render={<Button variant="icon" size="sm" aria-label="Close dialog" />}>
                <X aria-hidden="true" size={16} />
              </Dialog.Close>
            </div>
          )}
          {children}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
);
