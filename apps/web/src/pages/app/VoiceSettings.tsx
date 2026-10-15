import { Card, PageHeader } from "@/components/ui/Card";
import { VoicePicker } from "@/components/assistant/VoicePicker";

/** Settings → Voice: pick and tune the ElevenLabs voice JARVIS answers with. */
export function VoiceSettings() {
  return (
    <>
      <PageHeader title="Voice settings" description="Choose the ElevenLabs voice JARVIS speaks with and tune how it sounds. Your choice is personal and applies in every business." />
      <Card title="JARVIS voice">
        <VoicePicker />
      </Card>
    </>
  );
}
