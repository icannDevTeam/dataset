import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { studentId } = req.body;

    if (!studentId) {
      return res.status(400).json({ error: 'studentId is required' });
    }

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      console.error('API_KEY not configured');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Step 1: Get auth token
    let token;
    try {
      const tokenResponse = await axios.get(
        'http://binusian.ws/binusschool/auth/token',
        {
          headers: {
            'Authorization': `Basic ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      // Handle different token response formats
      token = tokenResponse.data?.data?.token || 
              tokenResponse.data?.token || 
              tokenResponse.data?.access_token;
      
      if (!token) {
        console.error('No token in response:', JSON.stringify(tokenResponse.data, null, 2));
        return res.status(500).json({ error: 'Failed to get authentication token' });
      }
    } catch (error) {
      console.error('Token fetch error:', error.message);
      return res.status(500).json({ 
        error: 'Failed to authenticate with Binus API',
        details: error.message 
      });
    }

    // Step 2: Call C2 endpoint to get student data
    let studentResponse;
    try {
      studentResponse = await axios.post(
        'http://binusian.ws/binusschool/bss-student-enrollment',
        { IdStudent: String(studentId) },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
    } catch (error) {
      console.error('Student lookup error:', error.message);
      
      // Handle timeout errors specifically
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        return res.status(504).json({ 
          error: 'API request timeout - Binus system is slow to respond',
          details: 'Please try again in a moment'
        });
      }
      
      return res.status(500).json({ 
        error: 'Failed to lookup student',
        details: error.message 
      });
    }

    // Step 3: Parse response
    const result = studentResponse.data;
    
    console.log('Raw API response:', JSON.stringify(result, null, 2));
    
    if (result?.resultCode !== 200) {
      console.error('API returned non-200 result:', result);
      return res.status(404).json({ 
        error: 'Student not found',
        resultCode: result?.resultCode,
        details: result?.errorMessage || 'Unknown error'
      });
    }

    const studentData = result.studentDataResponse || result.data || result;
    
    console.log('Parsed student data:', JSON.stringify(studentData, null, 2));
    
    // Check if we got valid student data
    if (!studentData || !studentData.studentName) {
      return res.status(404).json({ 
        error: `Student with ID '${studentId}' not found in Binus system`,
        details: 'The API returned no student data for this ID'
      });
    }

    // Step 4: Extract fields (same as make_dataset.py logic)
    const studentName = studentData.studentName || 
                       studentData.name || 
                       studentData.fullName || 
                       'Unknown';
    
    const homeroom = studentData.homeroom || 
                    studentData.class || 
                    studentData.className || 
                    'Unknown';

    const gradeCode = studentData.gradeCode || 
                     studentData.grade || 
                     'Unknown';

    const gradeName = studentData.gradeName || 
                     studentData.gradeName || 
                     'Unknown';

    console.log('✓ Student lookup successful:', { studentId, studentName, homeroom });

    return res.status(200).json({
      success: true,
      id: studentId,
      name: studentName,
      homeroom: homeroom,
      gradeCode: gradeCode,
      gradeName: gradeName,
      raw: studentData
    });

  } catch (error) {
    console.error('Unexpected error in student lookup:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
