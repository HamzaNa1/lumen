import { RefreshCw } from "lucide-react";
import { Button } from "./Button";

/** Offers to apply an update that is waiting. It stays until the viewer acts on it. */
export const UpdateToast = ({
  message,
  action,
  onAction,
}: {
  readonly message: string;
  readonly action: string;
  readonly onAction: () => void;
}): React.ReactElement => (
  <div className="toast update-toast" role="alert">
    <RefreshCw aria-hidden="true" size={17} />
    <span>{message}</span>
    <Button variant="primary" size="sm" onClick={onAction}>
      {action}
    </Button>
  </div>
);
