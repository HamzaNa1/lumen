import type { TranscodingSettings } from "@lumen/contracts";
import { Button, Form, SelectField, SwitchField, TextField } from "@lumen/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage } from "./format";
import { useRuntime } from "./Runtime";

export const TranscodingSettingsPanel = ({ connectionId }: { readonly connectionId: string }) => {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const queryKey = ["transcoding-settings", connectionId];
  const settings = useQuery({ queryKey, queryFn: () => runtime.admin.transcodingSettings() });
  const [draft, setDraft] = useState<TranscodingSettings | null>(null);
  const update = useMutation({
    mutationFn: (value: TranscodingSettings) => runtime.admin.updateTranscodingSettings(value),
    onSuccess: (value) => {
      queryClient.setQueryData(queryKey, value);
      setDraft(null);
    },
  });
  const value = draft ?? settings.data;
  const change = (patch: Partial<TranscodingSettings>) => {
    if (value) setDraft({ ...value, ...patch });
    update.reset();
  };
  return (
    <section className="settings-group" aria-labelledby="settings-transcoding">
      <h2 id="settings-transcoding">Server transcoding</h2>
      {settings.isPending ? (
        <p role="status">Loading transcoding settings…</p>
      ) : settings.isError ? (
        <div role="alert">
          {errorMessage(settings.error, "Could not load transcoding settings")}
          <Button onClick={() => void settings.refetch()}>Retry</Button>
        </div>
      ) : value ? (
        <Form
          className="panel transcoding-form"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(value);
          }}
        >
          <p className="transcoding-description">
            Convert media only when the browser needs it. Changes apply to new playback requests;
            turning this off stops active conversions.
          </p>
          <fieldset disabled={update.isPending}>
            <SwitchField
              label="Enable transcoding"
              checked={value.enabled}
              onCheckedChange={(enabled) => change({ enabled })}
              description="Compatible media always plays directly."
            />
            <SelectField
              label="Video encoder"
              value={value.encoder}
              options={[
                { value: "cpu", label: "CPU (software)" },
                { value: "nvenc", label: "NVIDIA NVENC" },
                { value: "vaapi", label: "VAAPI (Intel / AMD on Linux)" },
              ]}
              onValueChange={(encoder) =>
                change({ encoder, gpus: encoder === "vaapi" ? ["/dev/dri/renderD128"] : ["0"] })
              }
            />
            {value.encoder !== "cpu" ? (
              <TextField
                label="GPU devices"
                value={value.gpus.join(",")}
                onValueChange={(text) =>
                  change({ gpus: text.split(",").map((item) => item.trim()) })
                }
                description={
                  value.encoder === "vaapi"
                    ? "Comma-separated render devices, e.g. /dev/dri/renderD128, /dev/dri/renderD129. Jobs go to the least busy device."
                    : "Comma-separated GPU indices, e.g. 0,1. Jobs go to the least busy device."
                }
              />
            ) : null}
            <div className="transcoding-limits">
              <TextField
                label="CPU threads per job"
                type="number"
                min={1}
                max={256}
                value={String(value.threads)}
                onValueChange={(text) => change({ threads: Number(text) })}
                required
              />
              <TextField
                label="Maximum concurrent jobs"
                type="number"
                min={1}
                max={128}
                value={String(value.maxJobs)}
                onValueChange={(text) => change({ maxJobs: Number(text) })}
                required
              />
              {value.encoder !== "cpu" ? (
                <TextField
                  label="Maximum jobs per GPU"
                  type="number"
                  min={1}
                  max={32}
                  value={String(value.gpuJobs)}
                  onValueChange={(text) => change({ gpuJobs: Number(text) })}
                  required
                />
              ) : null}
            </div>
            <SwitchField
              label="Allow software video encoding"
              checked={value.softwareVideo}
              onCheckedChange={(softwareVideo) => change({ softwareVideo })}
              description="Required for CPU encoding and browsers that need WebM output. Hardware failures do not automatically fall back to CPU."
            />
            <TextField
              label="FFmpeg executable"
              value={value.ffmpeg}
              onValueChange={(ffmpeg) => change({ ffmpeg })}
              required
              description="Executable name on the server’s PATH or an absolute path."
            />
          </fieldset>
          {update.isError ? (
            <p role="alert" className="form-error">
              {errorMessage(update.error, "Could not save transcoding settings")}
            </p>
          ) : null}
          {update.isSuccess ? (
            <p role="status" className="form-success">
              Transcoding settings saved.
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button
              variant="ghost"
              disabled={draft === null || update.isPending}
              onClick={() => {
                setDraft(null);
                update.reset();
              }}
            >
              Discard changes
            </Button>
            <Button type="submit" variant="primary" disabled={draft === null || update.isPending}>
              {update.isPending ? "Saving…" : "Save transcoding settings"}
            </Button>
          </div>
        </Form>
      ) : null}
    </section>
  );
};
