import Head from 'next/head';
import React, { useState } from 'react';
import styles from '../styles/index.module.css';
import EnrollmentPage from '../components/EnrollmentPage';
import CapturePage from '../components/CapturePage';

export default function Home() {
  const [currentPage, setCurrentPage] = useState('enrollment');
  const [studentData, setStudentData] = useState(null);

  const handleStudentData = (data) => {
    setStudentData(data);
    setCurrentPage('capture');
  };

  const handleBackToEnrollment = () => {
    setStudentData(null);
    setCurrentPage('enrollment');
  };

  const handleUploadComplete = () => {
    handleBackToEnrollment();
  };

  return (
    <>
      <Head>
        <title>BINUS Facial Attendance System</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="Student photo enrollment for facial attendance" />
      </Head>
      <div className={styles.container}>
        {currentPage === 'enrollment' ? (
          <EnrollmentPage onStudentData={handleStudentData} />
        ) : (
          <CapturePage 
            studentData={studentData}
            onBack={handleBackToEnrollment}
            onUploadComplete={handleUploadComplete}
          />
        )}
      </div>
    </>
  );
}
