// roiTask.js

const admin = require('firebase-admin');
const dayjs = require('dayjs'); // Used for date formatting

// --- Firebase Admin SDK Initialization ---
let serviceAccount;
try {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
  console.log('DEBUG: Raw FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 from process.env:', serviceAccountBase64 ? 'Value is present' : 'Value is undefined/empty');

  if (!serviceAccountBase64) {
    throw new Error('❌ FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 environment variable is not set or is empty!');
  }

  // Decode the Base64 string and parse it as JSON
  serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  console.log("✅ Firebase service account loaded successfully from Base64.");
} catch (error) {
  console.error("❌ Failed to load Firebase service account:", error.message);
  console.error("❌ Full error details during service account loading:", error);
  // Exit the process if Firebase Admin SDK cannot be initialized, as it's critical
  process.exit(1);
}

console.log('🚀 Starting ROI Cron Script...');

// Initialize Firebase Admin SDK
// Ensure this block runs only once. If you have other parts of your app that initialize Firebase,
// you might need to check if an app already exists (admin.apps.length === 0).
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'rosnept', // Ensure this matches your Firebase project ID
  });
  console.log('✅ Firebase Admin Initialized');
} else {
  console.log('✅ Firebase Admin already initialized.');
}


const db = admin.firestore(); // Get a reference to the Firestore database

// --- Main ROI Task Logic ---
async function runRoiTaskNow() {
  console.log('🏁 Running Daily ROI Task...');

  try {
    // 1. Fetch all investment documents from the 'INVESTMENT' collection
    const snapshot = await db.collection('INVESTMENT').get();
    console.log(`🔍 Found ${snapshot.docs.length} investment documents to process.`);

    // 2. Iterate over each investment document
    for (const doc of snapshot.docs) {
      const investmentDocData = doc.data();
      const investmentDocRef = doc.ref; // Reference to the current investment document

      // Extract userId from the investment document
      const userId = investmentDocData.userId;
      if (!userId) {
        console.warn(`⚠️ Skipping investment ${doc.id} - No userId found in the document.`);
        continue; // Skip to the next document if no userId
      }

      // Reference to the user's profile document in the 'USERS' collection
      const userProfileRef = db.collection('USERS').doc(userId);

      // Access the activePlan map within the investment document
      const plan = investmentDocData.activePlan;

      // --- Data Validation Checks for 'activePlan' ---
      // Check if 'plan' exists and is a proper object/map
      if (!plan || typeof plan !== 'object') {
          console.warn(`⚠️ Skipping user ${userId} (Investment: ${doc.id}) - 'activePlan' is missing or malformed.`, { plan });
          continue; // Skip if activePlan is invalid
      }

      // --- Filtering Logic: Skip if the plan is not truly active ---
      if (!investmentDocData.hasActivePlan || !plan.isActive) {
          console.log(`⏸️ Skipping user ${userId} (Investment: ${doc.id}) - Plan is not generally active (hasActivePlan: ${!!investmentDocData.hasActivePlan}) or activePlan.isActive: ${!!plan.isActive}.`);
          continue; // Skip if the plan is explicitly marked as inactive
      }

      // --- Robustly get daysCompleted as a number ---
      // Ensure daysCompleted is treated as a number, defaulting to 0 if invalid
      const rawDaysCompleted = plan.daysCompleted;
      let currentDaysCompletedInPlan = 0; // Initialize to 0

      if (typeof rawDaysCompleted === 'number' && !isNaN(rawDaysCompleted)) {
          currentDaysCompletedInPlan = rawDaysCompleted;
      } else if (typeof rawDaysCompleted === 'string') {
          const parsed = parseFloat(rawDaysCompleted);
          if (!isNaN(parsed)) {
              currentDaysCompletedInPlan = parsed;
          }
      }
      // If after checks, it's still not a valid number (e.g., null, undefined, "abc"), it remains 0.

      // --- Robustly parse roiPercent to a number ---
      const parsedRoiPercent = parseFloat(plan.roiPercent || '0');
      // Ensure roiAmount is calculated correctly. Handle cases where parsedRoiPercent might be NaN.
      const roiAmount = plan.amount * (isNaN(parsedRoiPercent) ? 0 : parsedRoiPercent);
      const today = dayjs().format('YYYY-MM-DD'); // Format current date for consistency

      // 3. Process active plans (less than 7 days completed)
      if (currentDaysCompletedInPlan < 7) {
        const newDaysCompleted = currentDaysCompletedInPlan + 1;

        // Create the payout log entry. Use new Date() for the timestamp.
        // Firestore will automatically convert JavaScript Date objects to native Timestamps.
        const newPayoutLogEntry = {
            date: today,
            amount: roiAmount,
            status: 'paid',
            timestamp: new Date(), // Correct way to add a timestamp to an array element
        };

        // Prepare updates for the INVESTMENT document
        const investmentUpdates = {
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1), // Increment days completed
          payoutLogs: admin.firestore.FieldValue.arrayUnion(newPayoutLogEntry), // Add payout log
        };

        // Prepare updates for the USER'S PROFILE (USERS collection)
        const userProfileUpdates = {
          walletBalance: admin.firestore.FieldValue.increment(roiAmount), // Increase user's wallet balance
          currentPlanDaysCompleted: newDaysCompleted, // Update days completed in user profile
          currentPlanRoiPercentage: parsedRoiPercent, // Update ROI percentage in user profile
          lastRoiPaymentDate: today, // Record last payment date
          hasActiveInvestments: true // Assume active as we are processing it, will be false if plan finishes
        };

        // Check if the plan is completed (7 days reached)
        if (newDaysCompleted >= 7) {
          if (plan.action === 'restart') {
            // If action is 'restart', reset days and keep active status
            investmentUpdates['activePlan.daysCompleted'] = 0; // Reset days to 0
            investmentUpdates['activePlan.status'] = 'active'; // Ensure status is active
            investmentUpdates['activePlan.isActive'] = true; // Ensure active status
            investmentUpdates['activePlan.action'] = 'active'; // Reset action to active
            console.log(`🔁 Restarted plan for user ${userId} (Investment: ${doc.id}).`);

            userProfileUpdates.currentPlanDaysCompleted = 0; // Reset user's days completed
            userProfileUpdates.hasActiveInvestments = true; // User still has active investments
          } else {
            // If action is not 'restart', mark plan as completed and inactive
            investmentUpdates['activePlan.isActive'] = false; // Mark plan as inactive
            investmentUpdates['activePlan.status'] = 'completed'; // Set status to completed
            investmentUpdates.hasActivePlan = false; // Ensure top-level hasActivePlan is false
            console.log(`🎉 Plan for user ${userId} (Investment: ${doc.id}) completed and marked inactive.`);

            userProfileUpdates.currentPlanDaysCompleted = newDaysCompleted; // Finalize days completed
            userProfileUpdates.hasActiveInvestments = false; // User no longer has active investments from this plan
          }
        }

        // Perform the updates as batch or individual updates
        // Using individual updates here for clarity and simplicity as Firestore handles concurrency for increments and arrayUnions
        await investmentDocRef.update(investmentUpdates);
        await userProfileRef.update(userProfileUpdates);

        console.log(`✅ Paid $${roiAmount.toFixed(2)} to user ${userId} (Plan: ${plan.planName || 'Unnamed'}). New Days Completed: ${newDaysCompleted}.`);

      } else {
        // 4. Handle plans that are already completed (>= 7 days)
        console.log(`🛑 Skipping user ${userId} (Investment: ${doc.id}) - plan already completed ${currentDaysCompletedInPlan} days.`);

        // If a plan is found that is already completed but still marked active, auto-correct it
        if (investmentDocData.hasActivePlan || plan.isActive) {
          await investmentDocRef.update({
            'activePlan.isActive': false,
            'activePlan.status': 'completed',
            hasActivePlan: false // Ensure top-level status is also false
          });
          await userProfileRef.update({
            hasActiveInvestments: false,
            currentPlanDaysCompleted: currentDaysCompletedInPlan, // Set to final days completed
          });
          console.log(`⚠️ Auto-marked user ${userId}'s plan (Investment: ${doc.id}) as completed and updated user profile due to daysCompleted >= 7.`);
        }
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
    console.error('❌ Full error details:', err);
  }
}

// --- Trigger the cron script execution ---
// This ensures that when the file is run, the main function is called.
runRoiTaskNow();