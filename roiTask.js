// roiTask.js

const admin = require('firebase-admin');
const dayjs = require('dayjs'); // dayjs is good for date formatting

// --- Firebase Admin SDK Initialization ---
let serviceAccount;
try {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
  console.log('DEBUG: Raw FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 from process.env:', serviceAccountBase64 ? 'Value is present' : 'Value is undefined/empty');

  if (!serviceAccountBase64) {
    throw new Error('❌ FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 environment variable is not set or is empty!');
  }

  serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  console.log("✅ Firebase service account loaded successfully from Base64.");
} catch (error) {
  console.error("❌ Failed to load Firebase service account:", error.message);
  console.error("❌ Full error details during service account loading:", error);
  process.exit(1);
}

console.log('🚀 Starting ROI Cron Script...');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'rosnept', // Ensure this is your actual Firebase Project ID
});

console.log('✅ Firebase Admin Initialized');

const db = admin.firestore();

// --- Main ROI Task Logic ---
async function runRoiTaskNow() {
  console.log('🏁 Running Daily ROI Task...');

  try {
    const snapshot = await db.collection('INVESTMENT').get();
    console.log(`🔍 Found ${snapshot.docs.length} investment documents to process.`);

    for (const doc of snapshot.docs) {
      const investmentDocData = doc.data(); // This is the INVESTMENT document's data
      const investmentDocRef = doc.ref;
      const plan = investmentDocData.activePlan;

      const userId = investmentDocData.userId;
      if (!userId) {
        console.warn(`⚠️ Skipping investment ${doc.id} - No userId found in the document.`);
        continue;
      }
      const userProfileRef = db.collection('USERS').doc(userId); // Reference to the actual USER document

      // --- FIX 1: Corrected Filtering Logic ---
      // We check if:
      // 1. The top-level 'hasActivePlan' is true.
      // 2. The 'activePlan' map exists and its 'isActive' field is true.
      // (Removed checks for `plan.status` and `plan.action` which don't exist as expected)
      if (!investmentDocData.hasActivePlan || !plan?.isActive) {
          console.log(`⏸️ Skipping user ${userId} (Investment: ${doc.id}) - Plan is not generally active (hasActivePlan: ${investmentDocData.hasActivePlan}) or activePlan.isActive: ${plan?.isActive}.`);
          continue;
      }

      // It's also good practice to ensure 'plan' itself is an object if it might be missing
      if (!plan || typeof plan !== 'object') {
          console.warn(`⚠️ Skipping user ${userId} (Investment: ${doc.id}) - activePlan is missing or malformed.`);
          continue;
      }


      if (plan.daysCompleted < 7) { // Assuming 7 days is the plan duration
        // --- FIX 2: Parse roiPercent to a number ---
        const parsedRoiPercent = parseFloat(plan.roiPercent || 0); // Convert string "0.04" to number 0.04
        const roiAmount = plan.amount * parsedRoiPercent;

        const today = dayjs().format('YYYY-MM-DD');
        const newDaysCompleted = plan.daysCompleted + 1; // Now plan.daysCompleted is a number


        // --- Updates for the INVESTMENT document ---
        const investmentUpdates = {
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid', // This status refers to the payout log entry
            timestamp: admin.firestore.FieldValue.serverTimestamp() // Add a server timestamp for accuracy
          }),
        };

        // --- Updates for the USER'S PROFILE (USERS collection) ---
        const userProfileUpdates = {
          walletBalance: admin.firestore.FieldValue.increment(roiAmount), // Increment user's wallet
          // These fields will reflect the current active plan's status on the user's profile
          currentPlanDaysCompleted: newDaysCompleted,
          currentPlanRoiPercentage: parsedRoiPercent, // Use the parsed number
          lastRoiPaymentDate: today, // Optional: add a timestamp for last payment
          // Add/update hasActiveInvestments on the user profile, reflecting the INVESTMENT document's state
          hasActiveInvestments: investmentDocData.hasActivePlan // Keep consistent with INVESTMENT doc
        };

        if (newDaysCompleted >= 7) {
          // If you have an 'action' field on the plan that dictates restart vs complete,
          // make sure it's actually set in your Firestore documents.
          // Based on your provided document, 'plan.action' is currently undefined.
          // So, the 'restart' branch below might never be hit unless you add that field.
          if (plan.action === 'restart') { // If plan.action is ever set to 'restart'
            investmentUpdates['activePlan.daysCompleted'] = 0;
            investmentUpdates['activePlan.status'] = 'active'; // This status might be for your internal logic, but not in your doc
            investmentUpdates['activePlan.isActive'] = true;
            investmentUpdates['activePlan.action'] = 'active'; // Assuming 'action' is a field you plan to use

            console.log(`🔁 Restarted plan for user ${userId} (Investment: ${doc.id})`);

            // Also reset user profile fields if the plan restarts
            userProfileUpdates.currentPlanDaysCompleted = 0; // Reset for user profile
            userProfileUpdates.hasActiveInvestments = true; // Still active for user profile
            // userProfileUpdates.currentPlanRoiPercentage remains the same for the new cycle
          } else { // Default to completing the plan if not set to restart
            investmentUpdates['activePlan.isActive'] = false;
            investmentUpdates['activePlan.status'] = 'completed'; // This status might be for your internal logic, but not in your doc
            console.log(`🎉 Plan for user ${userId} (Investment: ${doc.id}) completed and marked inactive.`);

            // Mark user profile plan details as completed/inactive
            userProfileUpdates.currentPlanDaysCompleted = newDaysCompleted; // Final days
            userProfileUpdates.currentPlanRoiPercentage = parsedRoiPercent; // Final ROI percentage
            userProfileUpdates.hasActiveInvestments = false; // User profile reflects no active investment
          }
        }

        // Perform updates on both documents
        await investmentDocRef.update(investmentUpdates); // Update INVESTMENT document
        await userProfileRef.update(userProfileUpdates); // Update USERS document

        console.log(`✅ Paid $${roiAmount.toFixed(2)} to user ${userId} (Plan: ${plan.planName || 'Unnamed'}). Days: ${newDaysCompleted}`);
      } else {
        // This block handles plans that have already reached or exceeded 7 days
        console.log(`🛑 Skipping user ${userId} (Investment: ${doc.id}) - plan already completed ${plan.daysCompleted} days.`);

        // Ensure plans past duration are marked inactive in INVESTMENT and USERS
        // This 'if' condition here will now actually trigger since plan.isActive is true for your user
        if (investmentDocData.hasActivePlan || plan.isActive) { // Check both top-level and activePlan status
          await investmentDocRef.update({
            'activePlan.isActive': false,
            // 'activePlan.status': 'completed', // You can uncomment if you add this field to activePlan
            hasActivePlan: false // Also update the top-level flag
          });
          // Also update user profile if their active plan is now completed
          await userProfileRef.update({
            hasActiveInvestments: false,
            currentPlanDaysCompleted: plan.daysCompleted, // Final days count
            // currentPlanRoiPercentage: parsedRoiPercent, // Keep final ROI
          });
          console.log(`⚠️ Auto-marked user ${userId}'s plan (Investment: ${doc.id}) as completed and updated user profile.`);
        }
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
    console.error('❌ Full error details:', err);
  }
}

// --- Trigger Script ---
runRoiTaskNow();