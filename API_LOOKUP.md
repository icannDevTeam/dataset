# 🔗 API Integration - Student Lookup (C2)

## How It Works

The web collector now uses the **same Binus API integration** as your `make_dataset.py` system.

### Flow

```
Student enters ID
    ↓
Frontend calls /api/student/lookup
    ↓
Backend:
  1. Get auth token from Binus API (using API_KEY)
  2. Call C2 endpoint (bss-student-enrollment) with ID
  3. Extract: studentName, homeroom, gradeCode
    ↓
Frontend:
  1. Auto-fills Name & Class fields
  2. Displays confirmation
  3. Saves metadata to Firebase
  4. Proceeds to capture
```

## API Endpoints

### POST /api/student/lookup
Lookup student information from Binus API.

**Request:**
```json
{
  "studentId": "2401234567"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "studentId": "2401234567",
  "name": "John Doe",
  "homeroom": "1A",
  "gradeCode": "1",
  "gradeName": "Grade 1",
  "message": "Student found"
}
```

**Error Response (404):**
```json
{
  "error": "Student not found",
  "code": 404,
  "message": "No student with that ID"
}
```

### POST /api/student/metadata
Save student metadata to Firebase.

**Request:**
```json
{
  "studentId": "2401234567",
  "studentName": "John Doe",
  "className": "1A",
  "gradeCode": "1",
  "gradeName": "Grade 1"
}
```

**Success Response:**
```json
{
  "success": true,
  "message": "Metadata saved successfully",
  "path": "face_dataset/1A/John Doe/metadata.json"
}
```

## Binus API Details

### C2 Endpoint
- **URL**: `http://binusian.ws/binusschool/bss-student-enrollment`
- **Method**: `POST`
- **Auth**: `Bearer {TOKEN}`
- **Body**: `{ "IdStudent": "2401234567" }`

### Response Fields
```json
{
  "studentDataResponse": {
    "studentName": "John Doe",           // Student's full name
    "homeroom": "1A",                    // Class/homeroom
    "gradeCode": "1",                    // Grade number
    "gradeName": "Grade 1",              // Grade name
    ...
  },
  "resultCode": 200
}
```

### Field Mapping
| API Field | Used As | Fallback |
|-----------|---------|----------|
| `studentName` | Student Name | Prompt user |
| `homeroom` | Class | Unknown |
| `gradeCode` | Grade (optional) | Empty |
| `gradeName` | Grade Name (optional) | Empty |

## Same as make_dataset.py

This uses the **exact same logic** as your existing system:

```python
# From make_dataset.py (line 48-54)
record = api_integrate.get_student_by_id_c2(studentid)
if isinstance(record, dict):
    student_name = record.get('studentName') or record.get('name') or record.get('fullName')
    class_name = record.get('homeroom') or record.get('class') or record.get('className')
```

**Now also in web collector:**

```javascript
// From api/index.js
const studentData = result.studentDataResponse;
const studentName = studentData.studentName || studentData.name || studentData.fullName;
const homeroom = studentData.homeroom || studentData.class || studentData.className;
```

## Credentials

The web collector uses the same:
- **API_KEY**: From your `.env` (shared)
- **Binus API Endpoint**: `http://binusian.ws/binusschool/`

**Setup:**
```bash
cd web-dataset-collector
# .env.local contains:
API_KEY=YOUR_KEY_HERE  # Same as parent .env
FIREBASE_*=...         # Your Firebase credentials
```

## Error Handling

### Common Errors

**"API_KEY not configured"**
- Ensure API_KEY is in `.env.local`
- Verify it's not empty

**"Failed to get auth token"**
- API_KEY may be invalid
- Binus API might be down
- Network connectivity issue

**"Student not found"**
- Student ID doesn't exist
- ID is incorrect (typo)
- Student not in system

### Debugging

Check Vercel logs:
```
vercel logs [project-id] --tail
```

Look for:
- Token acquisition errors
- API response codes
- Student data extraction issues

## Flow Diagram

```
WEB COLLECTOR              VERCEL BACKEND            BINUS API
┌─────────────┐           ┌────────────┐            ┌─────────┐
│   Student   │           │  Express   │            │  C2     │
│   enters ID │──POST───→ │  Endpoint  │───POST───→ │Endpoint │
│             │ /lookup   │            │ (Bearer)   │         │
│             │           │            │            │         │
│             │ ←JSON──── │ Extract    │ ←JSON───── │ Returns │
│ Auto-fills  │   data    │ name/class │ student    │ student │
│ Name/Class  │           │ Save meta  │ data      │ info    │
└─────────────┘           └────────────┘            └─────────┘
```

## Testing

### Test with cURL

```bash
# Get token first
TOKEN=$(curl -s -H "Authorization: Basic YOUR_API_KEY" \
  "http://binusian.ws/binusschool/auth/token" | jq -r '.data.token')

# Call C2 endpoint
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"IdStudent":"2401234567"}' \
  "http://binusian.ws/binusschool/bss-student-enrollment"
```

### Test via Web Collector

1. Deploy web collector to Vercel
2. Go to your URL
3. Enter a student ID
4. Should see auto-filled name and class
5. Check browser console for any errors

## Troubleshooting

### Student not found but ID is correct
1. Verify ID in Binus system
2. Check API_KEY is valid
3. Try another student ID

### Names not auto-filling
1. Check Vercel logs for API errors
2. Verify `API_KEY` is in `.env.local`
3. Check response in browser DevTools

### Grade information not showing
1. Grade fields are optional
2. Binus API may not include them
3. Falls back to empty string

## Next Steps

1. Deploy web collector with this API integration
2. Test with your students
3. Verify names/classes are correct
4. Images will be organized by class automatically

---

**System**: Facial Attendance v2.1
**Integration**: Binus API C2 (Student Enrollment)
**Status**: ✅ Ready for deployment
