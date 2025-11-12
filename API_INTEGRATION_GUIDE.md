# 📱 SMS Server API Integration Guide

## 🎯 Base URL

**Development:** `http://localhost:3000`  
**Production:** `https://your-domain.vercel.app` (or your deployment URL)

---

## 🔐 Authentication

All requests require:

1. **Authorization Header:** JWT token (if auth enabled)
2. **SMS API Key Header:** User-specific API key

```http
Authorization: Bearer <jwt-token>
X-SMS-API-Key: <user-sms-api-key>
```

**Development Mode (Auth Disabled):**

- Authorization header not required
- Only X-SMS-API-Key needed

---

## 📨 SMS Ingest Endpoint

### **POST /api/sms/ingest**

Submit new SMS messages for processing.

#### **Request:**

```http
POST /api/sms/ingest HTTP/1.1
Host: localhost:3000
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
X-SMS-API-Key: GoodGuy@123

{
  "sender": "HDFCBK",
  "senderName": "HDFC Bank",
  "message": "Your A/c XX1234 debited for Rs 500.00 on 11-Nov-25 at Swiggy. Avl Bal: Rs 5,234.50",
  "timestamp": "2025-11-11T14:30:00.000Z",
  "date": "2025-11-11",
  "time": "14:30:00",
  "receiver": "+919876543210",
  "receiverPhone": "+919876543210",
  "receiver_phone_number": "+919876543210",
  "isFinancial": true,
  "is_financial": true
}
```

#### **Field Mapping:**

| Field                   | Type                | Required | Description                    |
| ----------------------- | ------------------- | -------- | ------------------------------ |
| `sender`                | string              | **Yes**  | SMS sender ID (e.g., "HDFCBK") |
| `senderName`            | string              | Optional | Human-readable sender name     |
| `message`               | string              | **Yes**  | Complete SMS body text         |
| `timestamp`             | string (ISO8601)    | **Yes**  | When SMS was received          |
| `date`                  | string (YYYY-MM-DD) | Optional | Date part of timestamp         |
| `time`                  | string (HH:mm:ss)   | Optional | Time part of timestamp         |
| `receiver`              | string              | Optional | Phone number that received SMS |
| `receiverPhone`         | string              | Optional | Alias for receiver             |
| `receiver_phone_number` | string              | Optional | Alias for receiver             |
| `isFinancial`           | boolean/string      | Optional | Flag as financial SMS          |
| `is_financial`          | boolean/string      | Optional | Alias for isFinancial          |

**Note:** The API accepts multiple formats for flexibility (snake_case, camelCase).

#### **Response:**

**Success (201 Created):**

```json
{
  "message": "SMS ingested successfully",
  "smsId": 123,
  "status": "queued"
}
```

**Error (400 Bad Request):**

```json
{
  "error": "Missing required fields",
  "details": {
    "missing": ["sender", "message"]
  }
}
```

**Error (401 Unauthorized):**

```json
{
  "error": "Unauthorized"
}
```

**Error (403 Forbidden):**

```json
{
  "error": "Invalid SMS API key"
}
```

---

## 🔄 Processing Flow

```
1. SMS → POST /api/sms/ingest
   ↓
2. Stored in DB with status="queued"
   ↓
3. Cron job (runs every minute)
   ↓
4. GET /api/sms/process-queue (internal)
   ↓
5. Dev agent categorizes SMS
   ↓
6. Transaction created in DB
   ↓
7. Status updated to "processed"
```

**Processing Time:** 1-3 seconds (after cron picks it up)

---

## 📊 Transaction Query Endpoint

### **GET /api/transactions**

Retrieve user's transactions.

#### **Request:**

```http
GET /api/transactions?limit=25&cursor=abc123&startDate=2025-11-01&endDate=2025-11-30&type=debit HTTP/1.1
Host: localhost:3000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### **Query Parameters:**

| Parameter   | Type    | Default | Description                               |
| ----------- | ------- | ------- | ----------------------------------------- |
| `limit`     | number  | 25      | Number of transactions (1-100)            |
| `cursor`    | string  | -       | Pagination cursor from previous response  |
| `startDate` | ISO8601 | -       | Filter transactions after this date       |
| `endDate`   | ISO8601 | -       | Filter transactions before this date      |
| `type`      | string  | -       | Filter by type: credit/debit/refund/other |

#### **Response:**

```json
{
  "transactions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "owner": 2,
      "amount": 500.0,
      "currency": "INR",
      "type": "debit",
      "category": "Food & Dining",
      "description": "Swiggy order",
      "medium": "UPI",
      "targetParty": "Swiggy",
      "eventDate": "2025-11-11T14:30:00.000Z",
      "date_of_transaction": "2025-11-11T14:30:00.000Z",
      "date_created": "2025-11-11T14:31:45.123Z",
      "sms_message_id": 123,
      "sms_messages": {
        "id": 123,
        "raw_text": "Your A/c XX1234 debited..."
      }
    }
  ],
  "nextCursor": "xyz789",
  "hasMore": true
}
```

---

## 🛠️ Example Integration Code

### **Node.js / JavaScript:**

```javascript
const axios = require("axios");

const SMS_API_KEY = "GoodGuy@123";
const API_BASE_URL = "http://localhost:3000";
const JWT_TOKEN = "your-jwt-token"; // Optional in dev mode

async function sendSMS(smsData) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}/api/sms/ingest`,
      {
        sender: smsData.sender,
        senderName: smsData.senderName,
        message: smsData.message,
        timestamp: new Date(smsData.timestamp).toISOString(),
        date: smsData.date,
        time: smsData.time,
        receiver: smsData.receiver,
        isFinancial: true,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-SMS-API-Key": SMS_API_KEY,
          // 'Authorization': `Bearer ${JWT_TOKEN}` // Uncomment if auth enabled
        },
      }
    );

    console.log("✅ SMS ingested:", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
    throw error;
  }
}

// Example usage
sendSMS({
  sender: "HDFCBK",
  senderName: "HDFC Bank",
  message: "Your A/c XX1234 debited for Rs 500.00 on 11-Nov-25",
  timestamp: Date.now(),
  date: "2025-11-11",
  time: "14:30:00",
  receiver: "+919876543210",
});
```

### **Python:**

```python
import requests
from datetime import datetime

SMS_API_KEY = 'GoodGuy@123'
API_BASE_URL = 'http://localhost:3000'
JWT_TOKEN = 'your-jwt-token'  # Optional in dev mode

def send_sms(sms_data):
    headers = {
        'Content-Type': 'application/json',
        'X-SMS-API-Key': SMS_API_KEY,
        # 'Authorization': f'Bearer {JWT_TOKEN}'  # Uncomment if auth enabled
    }

    payload = {
        'sender': sms_data['sender'],
        'senderName': sms_data.get('senderName', ''),
        'message': sms_data['message'],
        'timestamp': datetime.now().isoformat(),
        'date': sms_data.get('date'),
        'time': sms_data.get('time'),
        'receiver': sms_data.get('receiver'),
        'isFinancial': True
    }

    response = requests.post(
        f'{API_BASE_URL}/api/sms/ingest',
        json=payload,
        headers=headers
    )

    if response.status_code == 201:
        print('✅ SMS ingested:', response.json())
        return response.json()
    else:
        print('❌ Error:', response.json())
        raise Exception(response.json())

# Example usage
send_sms({
    'sender': 'HDFCBK',
    'senderName': 'HDFC Bank',
    'message': 'Your A/c XX1234 debited for Rs 500.00',
    'date': '2025-11-11',
    'time': '14:30:00',
    'receiver': '+919876543210'
})
```

### **cURL:**

```bash
curl -X POST http://localhost:3000/api/sms/ingest \
  -H "Content-Type: application/json" \
  -H "X-SMS-API-Key: GoodGuy@123" \
  -d '{
    "sender": "HDFCBK",
    "senderName": "HDFC Bank",
    "message": "Your A/c XX1234 debited for Rs 500.00 on 11-Nov-25",
    "timestamp": "2025-11-11T14:30:00.000Z",
    "date": "2025-11-11",
    "time": "14:30:00",
    "receiver": "+919876543210",
    "isFinancial": true
  }'
```

---

## 🔧 Webhook Configuration (Optional)

If you want to receive callbacks when SMS is processed:

**Coming Soon:** `/api/sms/webhook/subscribe` endpoint for real-time notifications.

---

## 📝 SMS Message Format Guidelines

### **Bank Transaction SMS Examples:**

```
✅ Good Format:
"Your A/c XX1234 debited for Rs 500.00 on 11-Nov-25 at Swiggy. Avl Bal: Rs 5,234.50"

✅ Good Format:
"INR 1,500.00 credited to A/c XX5678 on 11-Nov-25. Salary from XYZ Corp."

✅ Good Format:
"You paid Rs 200 to Uber via UPI on 11-Nov-25 at 14:30"
```

### **Key Elements for Best Processing:**

1. **Amount:** Include currency and format (Rs/INR)
2. **Direction:** Use words like "debited", "credited", "paid", "received"
3. **Date/Time:** Include transaction timestamp
4. **Merchant/Party:** Name of vendor/recipient
5. **Account Reference:** Last 4 digits or identifier
6. **Medium:** UPI/Card/Cash (optional but helpful)

---

## 🚨 Error Handling

### **Common Errors:**

| Status Code | Error                   | Cause                             | Solution                           |
| ----------- | ----------------------- | --------------------------------- | ---------------------------------- |
| 400         | Missing required fields | sender or message not provided    | Include all required fields        |
| 401         | Unauthorized            | No auth token (when auth enabled) | Add Authorization header           |
| 403         | Invalid SMS API key     | Wrong API key                     | Check user's sms_app_api_key in DB |
| 404         | User not found          | userId doesn't exist              | Verify user ID is correct          |
| 500         | Internal server error   | Server-side issue                 | Check logs, retry                  |

### **Retry Strategy:**

```javascript
async function sendSMSWithRetry(smsData, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await sendSMS(smsData);
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
      console.log(`Retry ${attempt}/${maxRetries} after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
```

---

## 📊 Rate Limits

**Current Limits (can be adjusted):**

- SMS Ingest: No hard limit (recommended: max 100/minute per user)
- Transaction Query: No hard limit
- Cron Processing: 10 SMS per minute (automatic queue management)

---

## 🔐 Security Checklist

- [ ] **Always use HTTPS** in production
- [ ] **Store API keys securely** (never in code)
- [ ] **Validate SMS content** before sending
- [ ] **Implement retry logic** with exponential backoff
- [ ] **Log failed requests** for debugging
- [ ] **Monitor API usage** for anomalies

---

## 📞 Support

**Issues?** Check:

1. API key is correct (`users.sms_app_api_key` in database)
2. Content-Type header is `application/json`
3. Message format includes sender and message
4. Timestamp is valid ISO8601 format

**Still stuck?** Check server logs or contact support.
