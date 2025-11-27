import Client from "wacloud";

const phoneID = process.env.WA_PHONE_ID || "";
const businessAccountId = process.env.WA_BUSINESS_ACC_ID || "";
const token = process.env.WA_TOKEN || "";

const wacloud = new Client({
    phoneId: phoneID,
    businessAccountId: businessAccountId,
    token: token
});

export {wacloud};