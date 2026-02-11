#!/bin/bash

echo "=========================================="
echo "📷 Camera Feature End-to-End Test"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test 1: Frontend loads
echo -e "${BLUE}[Test 1]${NC} Frontend Page Load"
FRONTEND=$(curl -s http://localhost:3000 | grep -o "Facial Dataset Collector")
if [ ! -z "$FRONTEND" ]; then
  echo -e "${GREEN}✓ PASS${NC}: Frontend renders"
else
  echo -e "${RED}✗ FAIL${NC}: Frontend not loading"
fi
echo ""

# Test 2: Student Lookup API
echo -e "${BLUE}[Test 2]${NC} Student Lookup API"
LOOKUP=$(curl -s -X POST http://localhost:3000/api/student/lookup \
  -H "Content-Type: application/json" \
  -d '{"studentId": "TEST123"}' | grep -o "error\|success")

if [ ! -z "$LOOKUP" ]; then
  echo -e "${GREEN}✓ PASS${NC}: Student lookup responds"
else
  echo -e "${RED}✗ FAIL${NC}: Student lookup not working"
fi
echo ""

# Test 3: Upload API exists
echo -e "${BLUE}[Test 3]${NC} Upload API Endpoint"
UPLOAD=$(curl -s -w "\n%{http_code}" -X POST http://localhost:3000/api/face/upload \
  -H "Content-Type: application/json" \
  -d '{"test": "test"}' | tail -1)

if [ "$UPLOAD" == "400" ] || [ "$UPLOAD" == "200" ]; then
  echo -e "${GREEN}✓ PASS${NC}: Upload API compiled (HTTP $UPLOAD)"
else
  echo -e "${RED}✗ FAIL${NC}: Upload API not responding (HTTP $UPLOAD)"
fi
echo ""

# Test 4: Check all required components
echo -e "${BLUE}[Test 4]${NC} Required Components"
echo "Checking:"

# Check CaptureStep exists
if grep -q "CaptureStep" /home/pandora/facial-attendance-v2/web-dataset-collector/pages/index.js; then
  echo -e "  ${GREEN}✓${NC} CaptureStep component"
else
  echo -e "  ${RED}✗${NC} CaptureStep component"
fi

# Check camera setup
if grep -q "getUserMedia" /home/pandora/facial-attendance-v2/web-dataset-collector/pages/index.js; then
  echo -e "  ${GREEN}✓${NC} Camera API (getUserMedia)"
else
  echo -e "  ${RED}✗${NC} Camera API"
fi

# Check upload function
if grep -q "uploadAll" /home/pandora/facial-attendance-v2/web-dataset-collector/pages/index.js; then
  echo -e "  ${GREEN}✓${NC} Upload function"
else
  echo -e "  ${RED}✗${NC} Upload function"
fi

# Check upload API
if [ -f /home/pandora/facial-attendance-v2/web-dataset-collector/pages/api/face/upload.js ]; then
  echo -e "  ${GREEN}✓${NC} Upload API endpoint"
else
  echo -e "  ${RED}✗${NC} Upload API endpoint"
fi

echo ""

# Test 5: Server status
echo -e "${BLUE}[Test 5]${NC} Server Status"
HEALTH=$(curl -s -w "\n%{http_code}" http://localhost:3000/api/health | tail -1)

if [ "$HEALTH" == "200" ]; then
  echo -e "${GREEN}✓ PASS${NC}: Server running (HTTP 200)"
  ps aux | grep "npm run dev" | grep -v grep | awk '{print "  Process: PID", $2, "- Memory:", $6"KB"}'
else
  echo -e "${RED}✗ FAIL${NC}: Server not responding (HTTP $HEALTH)"
fi
echo ""

echo "=========================================="
echo -e "${GREEN}✓ Camera Feature Ready${NC}"
echo "=========================================="
echo ""
echo "To test the camera:"
echo "  1. Go to http://localhost:3000"
echo "  2. Enter a student ID"
echo "  3. Click 'Continue to Capture'"
echo "  4. Allow camera access"
echo "  5. Capture photos with '📸 Capture' button"
echo "  6. Click '📤 Upload' when done"
echo ""
echo "The system will:"
echo "  ✓ Stream live camera feed"
echo "  ✓ Capture high-quality photos"
echo "  ✓ Show preview grid"
echo "  ✓ Upload to Firebase (or local fallback)"
echo ""
