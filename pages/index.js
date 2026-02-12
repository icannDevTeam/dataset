import Head from 'next/head';
import Link from 'next/link';
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
        <div style={{
          position: 'fixed', top: 16, right: 16, display: 'flex', gap: 8, zIndex: 100
        }}>
          <Link href="/dashboard" style={{
            padding: '8px 14px', background: 'rgba(0,0,0,0.5)', color: '#34d399',
            borderRadius: 6, fontSize: '0.85rem', border: '1px solid rgba(52,211,153,0.3)',
            textDecoration: 'none'
          }}>
            📊 Dashboard
          </Link>
          <Link href="/hikvision" style={{
            padding: '8px 14px', background: 'rgba(0,0,0,0.5)', color: '#38bdf8',
            borderRadius: 6, fontSize: '0.85rem', border: '1px solid rgba(56,189,248,0.3)',
            textDecoration: 'none'
          }}>
            🔐 Hikvision Portal
          </Link>
        </div>
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
