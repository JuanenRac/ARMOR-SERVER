# State-machine boundary

Only explicit `arm`, `disarm`, `intrusion` and `clear` events are accepted by
the core reducer. Adapters must authenticate callers before converting MQTT,
HTTP or voice input into these events.
