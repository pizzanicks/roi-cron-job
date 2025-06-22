// index.js (in your ROI-CRON-JOB project)

const admin = require('firebase-admin');
const cron = require('node-cron');
const dayjs = require('dayjs'); // dayjs is included, but native Date objects are sufficient for simple comparisons

// --- Firebase Admin SDK Initialization ---
// This block ensures your script can authenticate with Firebase Firestore.
// It prioritizes using a SERVICE_ACCOUNT_KEY from an environment variable,
// which is the secure and recommended way for external hosting like Railway.
if (process.env.SERVICE_ACCOUNT_KEY) {
    try {
        const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin SDK Initialized successfully using Service Account Key from environment variable.');
    } catch (e) {
        console.error('ERROR: Could not parse SERVICE_ACCOUNT_KEY environment variable. Make sure it is valid JSON and not corrupted. Exiting process.', e);
        process.exit(1); // Exit if initialization fails due to bad key
    }
} else {
    // This fallback is primarily for Firebase Cloud Functions environments
    // or local testing where Google Application Credentials might be set up.
    // For Railway, you MUST set SERVICE_ACCOUNT_KEY.
    console.warn('WARNING: SERVICE_ACCOUNT_KEY environment variable not found. Assuming Firebase Cloud Function or local development with default credentials.');
    admin.initializeApp();
}

const db = admin.firestore();

// --- Main ROI Calculation and Update Logic ---
/**
 * Asynchronously runs the daily ROI increase logic for active users.
 * It fetches investment plans, iterates through users, calculates ROI,
 * and updates user data in batches.
 */
async function runDailyROIIncrease() {
    console.log(`\n--- [${new Date().toISOString()}] Daily ROI Increase function started. ---`);

    try {
        // 1. Fetch all investment plans to get their daily ROI percentages
        console.log('Fetching all investment plans...');
        const investmentPlansSnapshot = await db.collection('investmentPlans').get();
        const investmentPlans = {};
        if (investmentPlansSnapshot.empty) {
            console.error('No investment plans found in Firestore. Please ensure your plans are in the "investmentPlans" collection.');
            return; // Cannot proceed without plans
        }
        investmentPlansSnapshot.docs.forEach(doc => {
            investmentPlans[doc.id] = doc.data();
        });
        console.log(`Successfully fetched ${Object.keys(investmentPlans).length} investment plans.`);

        // 2. Query for users with an 'active' earningStatus and an 'investmentPlanId'
        console.log('Querying for active users...');
        const activeUsersSnapshot = await db.collection('users')
            .where('earningStatus', '==', 'active')
            .get();

        if (activeUsersSnapshot.empty) {
            console.log('No active users found to process ROI. Exiting function.');
            return;
        }

        const batch = db.batch(); // Use a batch write for efficiency
        let usersProcessed = 0;
        let usersSkipped = 0;

        console.log(`Found ${activeUsersSnapshot.docs.length} active users. Processing...`);

        // Iterate through each active user document
        for (const doc of activeUsersSnapshot.docs) {
            const userData = doc.data();
            const userId = doc.id;
            const userDocRef = db.collection('users').doc(userId);

            const initialInvestmentAmount = userData.initialInvestmentAmount || 0;
            const investmentPlanId = userData.investmentPlanId; // The ID of the plan the user signed up for
            let currentROI = userData.currentROI || 0; // Cumulative ROI percentage (e.g., 4, 8, 12...)
            let roiIncreaseDayCount = userData.roiIncreaseDayCount || 0; // Current day count (1 to 7)
            const lastROIUpdateTimestamp = userData.lastROIUpdateDate; // Firestore Timestamp object
            const roiStartDateTimestamp = userData.roiStartDate; // Firestore Timestamp object

            // --- Validation and Skipping Conditions ---
            if (initialInvestmentAmount <= 0) {
                console.log(`  User ${userId}: Initial investment amount is zero or less. Skipping.`);
                usersSkipped++;
                continue;
            }
            if (!investmentPlanId) {
                console.log(`  User ${userId}: Missing investmentPlanId. Skipping.`);
                usersSkipped++;
                continue;
            }

            const plan = investmentPlans[investmentPlanId];
            if (!plan || typeof plan.dailyROI !== 'number') {
                console.warn(`  User ${userId}: Investment plan "${investmentPlanId}" not found or 'dailyROI' property missing/invalid. Skipping.`);
                usersSkipped++;
                continue;
            }

            const DAILY_ROI_PERCENTAGE_FOR_PLAN = plan.dailyROI; // Get ROI from the fetched plan
            const MAX_ROI_DAYS = 7; // Fixed investment cycle as per requirement

            // Convert Firestore Timestamps to JavaScript Date objects for comparisons
            const lastROIUpdateDate = lastROIUpdateTimestamp ? lastROIUpdateTimestamp.toDate() : null;
            const roiStartDate = roiStartDateTimestamp ? roiStartDateTimestamp.toDate() : null;

            const now = new Date(); // Current time of cron job execution

            // Determine if a full day has passed since the last update
            const lastUpdateCheckDate = lastROIUpdateDate || roiStartDate; // Prefer last update, fall back to start date

            if (lastUpdateCheckDate) {
                const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000; // Milliseconds in a day
                const timeDiffMs = now.getTime() - lastUpdateCheckDate.getTime();

                // Check if less than 24 hours (minus a small buffer for safety) has passed.
                // This prevents multiple updates within a day if the cron job runs slightly off schedule.
                if (timeDiffMs < ONE_DAY_IN_MS - (5 * 60 * 1000)) { // 5 minutes buffer
                    console.log(`  User ${userId}: Less than a full day passed since last update. Skipping this run.`);
                    usersSkipped++;
                    continue;
                }
            } else {
                console.log(`  User ${userId}: Missing 'lastROIUpdateDate' or 'roiStartDate'. Cannot determine update eligibility. Skipping.`);
                usersSkipped++;
                continue;
            }

            // Check if the 7-day cycle is already complete for this user
            if (roiIncreaseDayCount >= MAX_ROI_DAYS) {
                console.log(`  User ${userId}: 7-day ROI cycle already completed. Setting earningStatus to 'completed' if not already.`);
                // Only update if status is not already 'completed' to avoid unnecessary writes
                if (userData.earningStatus !== 'completed') {
                    batch.update(userDocRef, { earningStatus: 'completed' });
                    usersProcessed++; // Count this as a processed update for status change
                }
                continue; // Skip further ROI calculation for this user
            }

            // --- Perform ROI Calculation ---
            currentROI += DAILY_ROI_PERCENTAGE_FOR_PLAN; // Add daily ROI percentage
            roiIncreaseDayCount++; // Increment day count

            // Optional: Cap the currentROI to the maximum possible for the 7-day cycle
            // This prevents it from going over if somehow a calculation error occurred previously.
            const maxCumulativeROIForPlan = MAX_ROI_DAYS * DAILY_ROI_PERCENTAGE_FOR_PLAN;
            if (currentROI > maxCumulativeROIForPlan) {
                currentROI = maxCumulativeROIForPlan;
            }

            // Calculate the actual monetary value of the ROI
            const newROIValue = initialInvestmentAmount * (currentROI / 100);

            // Prepare update data for Firestore
            const updateData = {
                currentROI: parseFloat(currentROI.toFixed(2)), // Store with 2 decimal places
                currentROIValue: parseFloat(newROIValue.toFixed(2)), // Store with 2 decimal places
                roiIncreaseDayCount: roiIncreaseDayCount,
                lastROIUpdateDate: now, // Mark the time of this successful update
            };

            // If this update completes the 7-day cycle, set earningStatus to 'completed'
            if (roiIncreaseDayCount >= MAX_ROI_DAYS) {
                updateData.earningStatus = 'completed';
                console.log(`  User ${userId}: Completed 7-day ROI cycle! Setting earningStatus to 'completed'.`);
            }

            batch.update(userDocRef, updateData); // Add update to the batch
            usersProcessed++;
            console.log(`  User ${userId}: ROI updated. Day ${roiIncreaseDayCount}/${MAX_ROI_DAYS}. Plan: ${investmentPlanId} (Daily ROI: ${DAILY_ROI_PERCENTAGE_FOR_PLAN}%). New Total ROI%: ${currentROI.toFixed(2)}%. New ROI Value: $${newROIValue.toFixed(2)}.`);
        }

        // Commit all batched updates to Firestore
        if (usersProcessed > 0) {
            await batch.commit();
            console.log(`\n--- [${new Date().toISOString()}] Daily ROI Increase function completed. Committed updates for ${usersProcessed} users. Skipped ${usersSkipped} users. ---`);
        } else {
            console.log(`\n--- [${new Date().toISOString()}] No users needed ROI updates or all were skipped. ---`);
        }

    } catch (error) {
        console.error(`\n--- [${new Date().toISOString()}] CRITICAL ERROR in runDailyROIIncrease function:`, error);
        // In a production setup, consider sending an alert (email, Slack, etc.) here.
    }
}

// --- Schedule the cron job using 'node-cron' ---
// The cron expression '0 2 * * *' means "At 02:00 (2 AM) every day".
// This time is based on the server's timezone, which is typically UTC on cloud platforms like Railway.
// If you need a specific timezone for your 2 AM, uncomment and set the 'timezone' option below.
cron.schedule('0 2 * * *', () => {
    console.log(`\n--- [${new Date().toISOString()}] Running scheduled ROI job via node-cron... ---`);
    runDailyROIIncrease(); // Execute the main function
}, {
    // Example for a specific timezone (uncomment and adjust if needed):
    // timezone: "Africa/Lagos" // If you want 2 AM in Lagos time
});

console.log(`\n--- [${new Date().toISOString()}] ROI Cron Job Scheduler started. Next run scheduled for 2 AM (server time). ---`);

// Keep the Node.js process alive indefinitely for the cron scheduler to work.
// Railway will ensure this process keeps running.
// This is important because 'node-cron' runs within the same process.

// Graceful shutdown handling for Railway
process.on('SIGINT', () => {
    console.log('Received SIGINT signal. Shutting down cron job gracefully...');
    cron.destroy(); // Stop all scheduled tasks
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM signal. Shutting down cron job gracefully...');
    cron.destroy(); // Stop all scheduled tasks
    process.exit(0);
});
