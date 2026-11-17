import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { Phase } from "./dictation"

export interface ControlsProps {
  phase: Phase
  pending: boolean
  sameTarget: boolean
  compactDraft?: string
  color?: string | RGBA
  onToggle(): void
  onCancel(): void
  onInsert(): void
}

export interface PreviewProps {
  text: string
  visible: boolean
  pending: boolean
  color?: string | RGBA
}

function Button(props: {
  label: string
  disabled?: boolean
  color?: string | RGBA
  onPress(): void
}): JSX.Element {
  let armed = false
  let node: { screenX: number; screenY: number; width: number; height: number } | undefined
  return <box ref={(value) => { node = value }} height={1} paddingLeft={1} paddingRight={1}
    focusable={false} flexShrink={0}
    onMouseDown={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      armed = !props.disabled
    }}
    onMouseOut={() => { armed = false }}
    onMouseUp={(event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const pressed = armed
      armed = false
      if (pressed && !props.disabled && node
        && event.x >= node.screenX && event.x < node.screenX + node.width
        && event.y >= node.screenY && event.y < node.screenY + node.height) props.onPress()
    }}>
    <text selectable={false} fg={props.color}>{`[ ${props.label} ]`}</text>
  </box>
}

function tail(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length > limit ? `…${points.slice(-limit).join("")}` : text
}

export function DictationControls(props: ControlsProps): JSX.Element {
  const label = () => {
    if (props.pending) return "Mic Pending"
    if (props.phase === "recording") return "Mic Stop"
    if (props.phase === "starting") return "Mic Loading"
    if (props.phase === "transcribing") return "Mic Finishing"
    if (props.phase === "cancelling") return "Mic Cancelling"
    return "Mic Record"
  }
  return <box flexDirection="row" height={1} gap={1} flexShrink={0}>
    <Button label={label()} color={props.color} onPress={props.onToggle}
      disabled={props.pending || (props.phase !== "idle" && props.phase !== "recording")} />
    {props.pending && props.sameTarget
      ? <Button label="Insert" color={props.color} onPress={props.onInsert} /> : null}
    {props.phase !== "idle" || props.pending
      ? <Button label="Cancel" color={props.color} onPress={props.onCancel}
        disabled={props.phase === "cancelling"} /> : null}
    {props.pending && !props.sameTarget
      ? <text fg={props.color} selectable={false}>Pending elsewhere</text> : null}
    {props.compactDraft
      ? <text fg={props.color} selectable={false}>{tail(props.compactDraft, 24)}</text> : null}
  </box>
}

export function DictationPreview(props: PreviewProps): JSX.Element {
  return <>{props.visible ? <box width="100%" maxHeight={5} overflow="hidden"
    flexDirection="column" flexShrink={0} border={true}>
    <text fg={props.color} selectable={false}>{props.pending ? "Pending dictation" : "Live draft — not sent"}</text>
    <text fg={props.color} selectable={false} wrapMode="word">{tail(props.text, 240)}</text>
  </box> : null}</>
}
