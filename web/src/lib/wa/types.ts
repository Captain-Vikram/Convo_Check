export interface WhatsAppWebhook {
  object: string;
  entry: Entry[];
}

export interface Entry {
  id: string;
  changes: Change[];
}

export interface Change {
  field: string;
  value: Value;
}

export interface Value {
  messaging_product: string;
  metadata: Metadata;
  contacts: Contact[];
  messages: Message[];
}

export interface Metadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface Contact {
  profile: { name: string };
  wa_id: string;
}

export interface Message {
  from: string;
  id: string;
  timestamp: string;
  text?: { body: string };
  type: string;
  image?: {
    mime_type: string;
    sha256: string;
    id: string;
    caption?: string;
  };
  audio? : {
    mime_type: string;
    sha256: string;
    id: string;
    voice: boolean;
  }
}

