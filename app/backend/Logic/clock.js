function isWorkShiftStarted(startWorkShift, endWorkShift){
    const rangeArray = Array.from({ length: endWorkShift - startWorkShift + 1 }, (_, i) => startWorkShift + i);

    const data = new Date();
    const isUserComeInTimeHours = rangeArray.includes(data.getHours()) ? true : false;

    if(isUserComeInTimeHours){
        return true;
    }
    else{
        return false;
    }
}

module.exports = isWorkShiftStarted;